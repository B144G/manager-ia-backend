'use strict';
// Comptes : inscription, connexion, profil, sauvegarde de la progression.
const express = require('express');
const bcrypt = require('bcryptjs');
const { db, nowISO, publicUser, getUserFresh } = require('../db');
const limits = require('../middleware/limits');
const { setUserCookie, clearUserCookie, requireUser } = require('../middleware/auth');
const { notify } = require('../services/notify');
const { asyncHandler, HttpError, normalizeContact, cleanText, parseJSON } = require('../util');

const router = express.Router();
const crypto = require('crypto');
const config = require('../config');
const { mailUser, mailEnabled, sendMail } = require('../services/notify');
const sec = require('../services/security');
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');

const DOMAINS = ['ia', 'ecom', 'trading', 'web', 'port', 'stat', 'bud'];
const OTHERS = ['app', 'delegate', 'client'];
const VALID_INTERESTS = [...DOMAINS, ...OTHERS];
const FREE_MAX_DOMAINS = 2;
const DUMMY_HASH = bcrypt.hashSync('mot-de-passe-factice', sec.BCRYPT_COST);

const countDomains = (list) => list.filter((i) => DOMAINS.includes(i)).length;

function cleanInterests(v) {
  if (!Array.isArray(v) || v.length > 30) throw new HttpError(400, 'Centres d\'intérêt invalides.');
  const out = [];
  for (const i of v) {
    if (typeof i !== 'string' || !VALID_INTERESTS.includes(i)) throw new HttpError(400, 'Centre d\'intérêt inconnu.');
    if (!out.includes(i)) out.push(i);
  }
  return out;
}

function cleanProgress(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new HttpError(400, 'Progression invalide.');
  const keys = Object.keys(v);
  if (keys.length > 600) throw new HttpError(400, 'Progression trop volumineuse.');
  const out = {};
  for (const k of keys) {
    const m = /^([a-z]+):[A-Za-z0-9._-]{1,20}$/.exec(k);
    if (!m || !DOMAINS.includes(m[1])) throw new HttpError(400, 'Clé de progression invalide.');
    if (v[k] === true) out[k] = true;
  }
  return out;
}

function cleanProject(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new HttpError(400, 'Projet invalide.');
  const keys = Object.keys(v);
  if (keys.length > 120) throw new HttpError(400, 'Trop de projets.');
  const out = {};
  for (const k of keys) {
    const e = v[k];
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(k)) throw new HttpError(400, 'Mois de projet invalide.');
    if (!e || typeof e !== 'object' || typeof e.domain !== 'string' || !DOMAINS.includes(e.domain)) throw new HttpError(400, 'Projet invalide.');
    out[k] = { domain: e.domain, done: e.done === true };
  }
  return out;
}

// ---- Inscription ----
// L'inscription réelle exige un code à 6 chiffres valable 30 secondes envoyé par e-mail.
const CODE_MS = 30 * 1000;          // durée de vie du code
const RESEND_MS = 20 * 1000;        // attente avant de pouvoir redemander un code
const MAX_TRIES = 5;                // essais par code
const MAX_SENDS = 5;                // codes par heure et par adresse
const verifyOn = () => !config.testAuthBypass;
const codeHash = (contact, code) => crypto.createHmac('sha256', config.jwtSecret).update(`${contact}|${code}`).digest('hex');
const maskMail = (m) => m.replace(/^(.).*(@.*)$/, '$1***$2');

async function sendSignupCode(row, name) {
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const now = Date.now();
  const sent = await sendMail({
    to: row.contact,
    subject: 'Votre code de vérification MANAGER-IA',
    text: `Bonjour ${name},\n\nVotre code de vérification : ${code}\n\nIl est valable 30 secondes. Saisissez-le sur la page d'inscription pour terminer la création de votre compte.\n\nSi vous n'avez pas demandé ce code, ignorez ce message.\n\nL'équipe MANAGER-IA`,
  });
  if (!sent) throw new HttpError(503, "L'envoi d'e-mails n'est pas disponible pour le moment. Réessayez plus tard.");
  return { codeHash: codeHash(row.contact, code), expires: new Date(now + CODE_MS).toISOString(), at: new Date(now).toISOString() };
}
const sweepCodes = () => db.prepare('DELETE FROM signup_codes WHERE expires_at < ?').run(new Date(Date.now() - 10 * 60 * 1000).toISOString());
const PASSKEY_CHALLENGE_MS = 2 * 60 * 1000;
const passkeyId = (credentialId) => typeof credentialId === 'string' && /^[A-Za-z0-9_-]+$/.test(credentialId) ? credentialId : '';

async function saveChallenge(userId, purpose, challenge) {
  const id = crypto.randomBytes(24).toString('hex');
  const now = new Date();
  db.prepare('DELETE FROM webauthn_challenges WHERE expires_at < ?').run(now.toISOString());
  db.prepare('INSERT INTO webauthn_challenges (id, user_id, purpose, challenge, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, userId, purpose, challenge, new Date(now.getTime() + PASSKEY_CHALLENGE_MS).toISOString(), now.toISOString());
  return id;
}

function consumeChallenge(id, purpose) {
  if (typeof id !== 'string' || !/^[a-f0-9]{48}$/.test(id)) return null;
  return db.transaction(() => {
    const row = db.prepare('SELECT * FROM webauthn_challenges WHERE id = ? AND purpose = ?').get(id, purpose);
    if (row) db.prepare('DELETE FROM webauthn_challenges WHERE id = ?').run(id);
    return row && Date.parse(row.expires_at) > Date.now() ? row : null;
  })();
}

async function registrationOptions(user) {
  const existing = db.prepare('SELECT credential_id, transports FROM webauthn_credentials WHERE user_id = ?').all(user.id);
  const options = await generateRegistrationOptions({
    rpName: config.webAuthn.rpName,
    rpID: config.webAuthn.rpID,
    userID: new Uint8Array(Buffer.from(String(user.id))),
    userName: user.contact,
    userDisplayName: user.name,
    attestationType: 'none',
    excludeCredentials: existing.map((item) => ({ id: item.credential_id, transports: JSON.parse(item.transports) })),
    authenticatorSelection: { authenticatorAttachment: 'platform', residentKey: 'preferred', userVerification: 'required' },
    timeout: PASSKEY_CHALLENGE_MS,
  });
  return { options, challengeId: await saveChallenge(user.id, 'register', options.challenge) };
}

async function authenticationOptions(user, purpose) {
  const existing = db.prepare('SELECT credential_id, transports FROM webauthn_credentials WHERE user_id = ?').all(user.id);
  if (!existing.length) throw new HttpError(428, 'Enregistrez la sécurité biométrique de votre appareil pour continuer.');
  const options = await generateAuthenticationOptions({
    rpID: config.webAuthn.rpID,
    allowCredentials: existing.map((item) => ({ id: item.credential_id, transports: JSON.parse(item.transports) })),
    userVerification: 'required',
    timeout: PASSKEY_CHALLENGE_MS,
  });
  return { options, challengeId: await saveChallenge(user.id, purpose, options.challenge) };
}

async function verifyRegistration(userId, challengeId, response, purpose) {
  const challenge = consumeChallenge(challengeId, purpose);
  if (!challenge || challenge.user_id !== userId) throw new HttpError(400, 'La demande biométrique a expiré. Recommencez.');
  let verification;
  try {
    verification = await verifyRegistrationResponse({ response, expectedChallenge: challenge.challenge, expectedOrigin: config.webAuthn.origin, expectedRPID: config.webAuthn.rpID, requireUserVerification: true });
  } catch {
    throw new HttpError(400, 'La vérification biométrique a échoué. Réessayez sur cet appareil.');
  }
  if (!verification.verified) throw new HttpError(400, 'La vérification biométrique a échoué. Réessayez sur cet appareil.');
  const { credential } = verification.registrationInfo;
  db.prepare(`INSERT INTO webauthn_credentials (credential_id, user_id, public_key, counter, transports, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .run(credential.id, userId, Buffer.from(credential.publicKey).toString('base64'), credential.counter, JSON.stringify(credential.transports || []), nowISO());
}

async function verifyAuthentication(userId, challengeId, response, purpose) {
  const challenge = consumeChallenge(challengeId, purpose);
  if (!challenge || challenge.user_id !== userId) throw new HttpError(400, 'La demande biométrique a expiré. Recommencez.');
  const credentialId = passkeyId(response && response.id || '');
  const credential = db.prepare('SELECT * FROM webauthn_credentials WHERE credential_id = ? AND user_id = ?').get(credentialId, userId);
  if (!credential) throw new HttpError(401, 'Clé biométrique inconnue pour ce compte.');
  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: config.webAuthn.origin,
      expectedRPID: config.webAuthn.rpID,
      requireUserVerification: true,
      credential: { id: credential.credential_id, publicKey: new Uint8Array(Buffer.from(credential.public_key, 'base64')), counter: credential.counter, transports: JSON.parse(credential.transports) },
    });
  } catch {
    throw new HttpError(401, 'Empreinte ou vérification de l’appareil incorrecte.');
  }
  if (!verification.verified || !verification.authenticationInfo.userVerified) throw new HttpError(401, 'Empreinte ou vérification de l’appareil incorrecte.');
  db.prepare('UPDATE webauthn_credentials SET counter = ?, last_used_at = ? WHERE credential_id = ?')
    .run(verification.authenticationInfo.newCounter, nowISO(), credential.credential_id);
}

function createUser(res, { name, contact, hash, interests }) {
  const dup = 'Un compte existe déjà avec ce contact. Utilisez « Me connecter ».';
  let id;
  try {
    id = db.prepare('INSERT INTO users (name, contact, pass_hash, interests, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(name, contact, hash, JSON.stringify(interests), nowISO()).lastInsertRowid;
  } catch (e) {
    if (String(e.code || '').startsWith('SQLITE_CONSTRAINT')) throw new HttpError(409, dup);
    throw e;
  }
  setUserCookie(res, Number(id));
  sec.audit('register', null, Number(id), '');
  notify('inscription', `Nouvelle inscription : ${name} (${contact}) - intérêts : ${interests.join(', ') || 'aucun'}`);
  return publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id));
}

router.get('/register/info', (req, res) => res.json({ verify: verifyOn(), emailReady: mailEnabled() }));

router.post('/register', limits.register, asyncHandler(async (req, res) => {
  const b = req.body || {};
  const name = cleanText(b.name, 100);
  const contact = normalizeContact(b.contact);
  const pass = typeof b.pass === 'string' ? b.pass : '';
  if (!config.testAuthBypass && !mailEnabled()) throw new HttpError(503, "L'envoi d'e-mails n'est pas configuré. L'inscription nécessite une adresse e-mail vérifiée.");
  if (name.length < 2) throw new HttpError(400, 'Veuillez indiquer votre nom.');
  if (!contact) throw new HttpError(400, 'Contact invalide : entrez un e-mail ou un numéro de téléphone valide.');
  const pw = sec.passwordProblem(pass, name, contact.value);
  if (pw) throw new HttpError(400, pw);
  let interests = b.interests === undefined ? [] : cleanInterests(b.interests);
  // Offre Gratuite : 2 domaines maximum dès l'inscription (on garde les 2 premiers).
  let kept = 0;
  interests = interests.filter((i) => !DOMAINS.includes(i) || ++kept <= FREE_MAX_DOMAINS);

  const dup = 'Un compte existe déjà avec ce contact. Utilisez « Me connecter ».';
  if (db.prepare('SELECT 1 FROM users WHERE contact = ?').get(contact.value)) throw new HttpError(409, dup);

  const hash = await bcrypt.hash(pass, sec.BCRYPT_COST);
  if (config.testAuthBypass) return res.status(201).json({ user: createUser(res, { name, contact: contact.value, hash, interests }) });
  if (!contact.value.includes('@')) throw new HttpError(400, 'Entrez une adresse e-mail : nous vous y envoyons un code de vérification.');
  sweepCodes();
  const prev = db.prepare('SELECT * FROM signup_codes WHERE contact = ?').get(contact.value);
  const now = Date.now();
  const fresh = prev && now - Date.parse(prev.window_start) < 3600 * 1000;
  if (fresh && prev.sends >= MAX_SENDS) throw new HttpError(429, 'Trop de codes demandés pour cette adresse. Réessayez dans une heure.');
  const sent = await sendSignupCode({ contact: contact.value }, name);
  db.prepare(`INSERT INTO signup_codes (contact, name, pass_hash, interests, code_hash, expires_at, attempts, sent_at, sends, window_start)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
    ON CONFLICT(contact) DO UPDATE SET name = excluded.name, pass_hash = excluded.pass_hash, interests = excluded.interests, code_hash = excluded.code_hash,
      expires_at = excluded.expires_at, attempts = 0, sent_at = excluded.sent_at, sends = excluded.sends, window_start = excluded.window_start`)
    .run(contact.value, name, hash, JSON.stringify(interests), sent.codeHash, sent.expires, sent.at, fresh ? prev.sends + 1 : 1, fresh ? prev.window_start : sent.at);
  res.status(202).json({ verify: true, contact: maskMail(contact.value), expiresIn: CODE_MS / 1000, resendIn: RESEND_MS / 1000 });
}));

router.post('/register/resend', limits.make(15 * 60 * 1000, 20, 'Trop de demandes. Réessayez dans quelques minutes.'), asyncHandler(async (req, res) => {
  const contact = normalizeContact((req.body || {}).contact);
  const row = contact && verifyOn() ? db.prepare('SELECT * FROM signup_codes WHERE contact = ?').get(contact.value) : null;
  if (!row) throw new HttpError(400, 'Aucune inscription en attente pour cette adresse. Recommencez l\'inscription.');
  const wait = RESEND_MS - (Date.now() - Date.parse(row.sent_at));
  if (wait > 0) throw new HttpError(429, `Patientez ${Math.ceil(wait / 1000)} s avant de redemander un code.`);
  const fresh = Date.now() - Date.parse(row.window_start) < 3600 * 1000;
  if (fresh && row.sends >= MAX_SENDS) throw new HttpError(429, 'Trop de codes demandés pour cette adresse. Réessayez dans une heure.');
  const sent = await sendSignupCode(row, row.name);
  db.prepare('UPDATE signup_codes SET code_hash = ?, expires_at = ?, attempts = 0, sent_at = ?, sends = ?, window_start = ? WHERE contact = ?')
    .run(sent.codeHash, sent.expires, sent.at, fresh ? row.sends + 1 : 1, fresh ? row.window_start : sent.at, row.contact);
  res.json({ ok: true, expiresIn: CODE_MS / 1000, resendIn: RESEND_MS / 1000 });
}));

router.post('/register/verify', limits.make(15 * 60 * 1000, 40, 'Trop de tentatives. Réessayez dans quelques minutes.'), asyncHandler(async (req, res) => {
  const b = req.body || {};
  const contact = normalizeContact(b.contact);
  const code = typeof b.code === 'string' ? b.code.replace(/\s/g, '') : '';
  const row = contact ? db.prepare('SELECT * FROM signup_codes WHERE contact = ?').get(contact.value) : null;
  if (!row) throw new HttpError(400, 'Aucune inscription en attente pour cette adresse. Recommencez l\'inscription.');
  if (!/^\d{6}$/.test(code)) throw new HttpError(400, 'Entrez le code à 6 chiffres reçu par e-mail.');
  if (Date.parse(row.expires_at) <= Date.now()) throw new HttpError(400, 'Ce code a expiré (30 secondes). Demandez-en un nouveau.');
  if (row.attempts >= MAX_TRIES) throw new HttpError(429, 'Trop d\'essais pour ce code. Demandez-en un nouveau.');
  const a = Buffer.from(codeHash(row.contact, code), 'hex');
  const ok = crypto.timingSafeEqual(a, Buffer.from(row.code_hash, 'hex'));
  if (!ok) {
    db.prepare('UPDATE signup_codes SET attempts = attempts + 1 WHERE contact = ?').run(row.contact);
    throw new HttpError(400, 'Code incorrect.');
  }
  const user = db.transaction(() => {
    const u = createUser(res, { name: row.name, contact: row.contact, hash: row.pass_hash, interests: parseJSON(row.interests, []) });
    db.prepare('DELETE FROM signup_codes WHERE contact = ?').run(row.contact);
    return u;
  })();
  res.status(201).json({ user });
}));

// ---- Connexion ----
router.post('/login', limits.login, asyncHandler(async (req, res) => {
  const b = req.body || {};
  const contact = normalizeContact(b.contact);
  const pass = typeof b.pass === 'string' ? b.pass.slice(0, 200) : '';
  const fail = new HttpError(401, 'Contact ou mot de passe incorrect.');
  const key = contact ? 'u:' + contact.value : '';
  if (key) sec.assertNotLocked(key);
  const row = contact ? db.prepare('SELECT * FROM users WHERE contact = ?').get(contact.value) : null;
  const ok = await bcrypt.compare(pass, row ? row.pass_hash : DUMMY_HASH); // même durée si le compte n'existe pas
  if (!row || !ok) {
    if (key && sec.recordFail(key)) sec.audit('login_locked', req, row && row.id, 'verrouillage 15 min');
    else sec.audit('login_fail', req, row && row.id, '');
    throw fail;
  }
  sec.clearFails(key);
  if (config.testAuthBypass) {
    setUserCookie(res, row.id);
    return res.json({ user: publicUser(getUserFresh(row.id)) });
  }
  const enrolled = db.prepare('SELECT 1 FROM webauthn_credentials WHERE user_id = ? LIMIT 1').get(row.id);
  if (!enrolled) {
    if (!row.contact.includes('@')) throw new HttpError(428, 'Ajoutez une adresse e-mail vérifiée à votre compte avant de configurer sa clé biométrique.');
    const pending = db.prepare('SELECT * FROM signup_codes WHERE contact = ?').get(row.contact);
    const now = Date.now();
    const fresh = pending && now - Date.parse(pending.window_start) < 3600 * 1000;
    if (fresh && pending.sends >= MAX_SENDS) throw new HttpError(429, 'Trop de codes demandés pour cette adresse. Réessayez dans une heure.');
    const sent = await sendSignupCode(row, row.name);
    db.prepare(`INSERT INTO signup_codes (contact, name, pass_hash, interests, code_hash, expires_at, attempts, sent_at, sends, window_start)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
      ON CONFLICT(contact) DO UPDATE SET name = excluded.name, pass_hash = excluded.pass_hash, interests = excluded.interests, code_hash = excluded.code_hash,
        expires_at = excluded.expires_at, attempts = 0, sent_at = excluded.sent_at, sends = excluded.sends, window_start = excluded.window_start`)
      .run(row.contact, row.name, row.pass_hash, row.interests, sent.codeHash, sent.expires, sent.at, fresh ? pending.sends + 1 : 1, fresh ? pending.window_start : sent.at);
    return res.json({ verify: true, loginVerify: true, contact: maskMail(row.contact), expiresIn: CODE_MS / 1000, resendIn: RESEND_MS / 1000 });
  }
  const passkey = await authenticationOptions(row, 'login');
  res.json({ webauthn: 'authenticate', ...passkey });
}));

router.post('/login/verify-email', limits.make(15 * 60 * 1000, 20, 'Trop de tentatives. Réessayez dans quelques minutes.'), asyncHandler(async (req, res) => {
  const contact = normalizeContact((req.body || {}).contact);
  const code = typeof (req.body || {}).code === 'string' ? req.body.code.replace(/\s/g, '') : '';
  const row = contact && contact.value.includes('@') ? db.prepare('SELECT * FROM signup_codes WHERE contact = ?').get(contact.value) : null;
  if (!row || !db.prepare('SELECT 1 FROM users WHERE contact = ?').get(row.contact)) throw new HttpError(400, 'Aucune vérification en attente. Recommencez la connexion.');
  if (!/^\d{6}$/.test(code)) throw new HttpError(400, 'Entrez le code à 6 chiffres reçu par e-mail.');
  if (Date.parse(row.expires_at) <= Date.now()) throw new HttpError(400, 'Ce code a expiré (30 secondes). Recommencez la connexion.');
  if (row.attempts >= MAX_TRIES) throw new HttpError(429, 'Trop d’essais pour ce code. Recommencez la connexion.');
  const expected = Buffer.from(codeHash(row.contact, code), 'hex');
  if (!crypto.timingSafeEqual(expected, Buffer.from(row.code_hash, 'hex'))) {
    db.prepare('UPDATE signup_codes SET attempts = attempts + 1 WHERE contact = ?').run(row.contact);
    throw new HttpError(400, 'Code incorrect.');
  }
  db.prepare('DELETE FROM signup_codes WHERE contact = ?').run(row.contact);
  const user = db.prepare('SELECT * FROM users WHERE contact = ?').get(row.contact);
  const passkey = await registrationOptions(user);
  res.json({ webauthn: 'register', ...passkey });
}));

router.post('/webauthn/login/verify', limits.make(15 * 60 * 1000, 12, 'Trop de vérifications. Réessayez dans quelques minutes.'), asyncHandler(async (req, res) => {
  const b = req.body || {};
  const challenge = consumeChallenge(b.challengeId, b.enroll ? 'register' : 'login');
  if (!challenge) throw new HttpError(400, 'La demande biométrique a expiré. Recommencez la connexion.');
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(challenge.user_id);
  if (!user) throw new HttpError(401, 'Compte introuvable. Recommencez la connexion.');
  if (b.enroll) {
    let verification;
    try {
      verification = await verifyRegistrationResponse({ response: b.response, expectedChallenge: challenge.challenge, expectedOrigin: config.webAuthn.origin, expectedRPID: config.webAuthn.rpID, requireUserVerification: true });
    } catch {
      throw new HttpError(400, 'La vérification biométrique a échoué. Réessayez sur cet appareil.');
    }
    if (!verification.verified) throw new HttpError(400, 'La vérification biométrique a échoué. Réessayez sur cet appareil.');
    const { credential } = verification.registrationInfo;
    db.prepare('INSERT INTO webauthn_credentials (credential_id, user_id, public_key, counter, transports, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(credential.id, user.id, Buffer.from(credential.publicKey).toString('base64'), credential.counter, JSON.stringify(credential.transports || []), nowISO());
  } else {
    const credentialId = passkeyId(b.response && b.response.id || '');
    const credential = db.prepare('SELECT * FROM webauthn_credentials WHERE credential_id = ? AND user_id = ?').get(credentialId, user.id);
    if (!credential) throw new HttpError(401, 'Clé biométrique inconnue pour ce compte.');
    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response: b.response,
        expectedChallenge: challenge.challenge,
        expectedOrigin: config.webAuthn.origin,
        expectedRPID: config.webAuthn.rpID,
        requireUserVerification: true,
        credential: { id: credential.credential_id, publicKey: new Uint8Array(Buffer.from(credential.public_key, 'base64')), counter: credential.counter, transports: JSON.parse(credential.transports) },
      });
    } catch {
      throw new HttpError(401, 'Empreinte ou vérification de l’appareil incorrecte.');
    }
    if (!verification.verified || !verification.authenticationInfo.userVerified) throw new HttpError(401, 'Empreinte ou vérification de l’appareil incorrecte.');
    db.prepare('UPDATE webauthn_credentials SET counter = ?, last_used_at = ? WHERE credential_id = ?')
      .run(verification.authenticationInfo.newCounter, nowISO(), credential.credential_id);
  }
  sec.audit('login_ok', req, user.id, 'WebAuthn');
  setUserCookie(res, user.id);
  res.json({ user: publicUser(getUserFresh(user.id)) });
}));

router.post('/webauthn/register/options', requireUser, limits.make(15 * 60 * 1000, 10, 'Trop de demandes de vérification. Réessayez plus tard.'), asyncHandler(async (req, res) => {
  res.json(await registrationOptions(req.user));
}));

router.post('/webauthn/register/verify', requireUser, limits.make(15 * 60 * 1000, 10, 'Trop de tentatives de vérification. Réessayez plus tard.'), asyncHandler(async (req, res) => {
  await verifyRegistration(req.user.id, (req.body || {}).challengeId, (req.body || {}).response, 'register');
  setUserCookie(res, req.user.id);
  res.json({ ok: true });
}));

router.post('/webauthn/session/options', requireUser, limits.make(15 * 60 * 1000, 20, 'Trop de demandes biométriques. Réessayez plus tard.'), asyncHandler(async (req, res) => {
  res.json(await authenticationOptions(req.user, 'session'));
}));

router.post('/webauthn/session/verify', requireUser, limits.make(15 * 60 * 1000, 20, 'Trop de tentatives biométriques. Réessayez plus tard.'), asyncHandler(async (req, res) => {
  await verifyAuthentication(req.user.id, (req.body || {}).challengeId, (req.body || {}).response, 'session');
  setUserCookie(res, req.user.id);
  res.json({ ok: true });
}));

router.post('/session/activity', requireUser, (req, res) => {
  setUserCookie(res, req.user.id, req.auth.bioAt);
  res.json({ ok: true });
});

// ---- Mot de passe oublié ----
// Réponse toujours identique (on ne révèle pas si un compte existe). Compte avec e-mail et envoi d'e-mails activé : lien envoyé par e-mail.
// Sinon (téléphone) : l'administrateur est prévenu et envoie lui-même un lien (valable 1 h, usage unique) après avoir vérifié la personne.
const RESET_MS = 60 * 60 * 1000;
const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');
function makeResetLink(req, userId, by) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare("DELETE FROM password_resets WHERE user_id = ? AND used_at IS NULL").run(userId);
  db.prepare('INSERT INTO password_resets (user_id, token_hash, expires_at, created_by, created_at) VALUES (?, ?, ?, ?, ?)').run(userId, hashToken(token), new Date(Date.now() + RESET_MS).toISOString(), by, nowISO());
  const base = (config.siteUrl || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
  return { link: `${base}/reinitialiser.html?t=${token}`, expiresAt: new Date(Date.now() + RESET_MS).toISOString() };
}
router.post('/password/forgot', limits.make(15 * 60 * 1000, 6, 'Trop de demandes. Réessayez dans quelques minutes.'), (req, res) => {
  const contact = normalizeContact((req.body || {}).contact);
  const row = contact ? db.prepare('SELECT * FROM users WHERE contact = ?').get(contact.value) : null;
  if (row) {
    if (row.contact.includes('@') && mailEnabled()) {
      const { link } = makeResetLink(req, row.id, 'user');
      mailUser(row.contact, 'Réinitialisation de votre mot de passe - MANAGER-IA', `Bonjour ${row.name},\n\nVous avez demandé à changer votre mot de passe. Ouvrez ce lien (valable 1 heure, une seule fois) :\n${link}\n\nSi vous n'êtes pas à l'origine de cette demande, ignorez ce message : votre mot de passe reste inchangé.\n\nL'équipe MANAGER-IA`);
    } else {
      notify('reinitialisation', `Demande de réinitialisation de mot de passe : ${row.name} (${row.contact}). Vérifiez la personne, puis générez un lien dans Administration > Utilisateurs.`);
    }
  }
  res.json({ ok: true, message: "Si un compte existe avec ce contact, vous allez recevoir un lien par e-mail. Pour un compte avec téléphone, l'équipe vous contactera pour vérifier votre identité." });
});
router.post('/password/reset', limits.make(15 * 60 * 1000, 10, 'Trop de tentatives. Réessayez dans quelques minutes.'), asyncHandler(async (req, res) => {
  const b = req.body || {};
  const token = typeof b.token === 'string' ? b.token.slice(0, 100) : '';
  const pass = typeof b.pass === 'string' ? b.pass : '';
  const pw = sec.passwordProblem(pass);
  if (pw) throw new HttpError(400, pw);
  const r = /^[a-f0-9]{64}$/.test(token) ? db.prepare('SELECT * FROM password_resets WHERE token_hash = ?').get(hashToken(token)) : null;
  if (!r || r.used_at || Date.parse(r.expires_at) < Date.now()) throw new HttpError(400, 'Ce lien n\'est plus valable (il dure 1 heure et ne sert qu\'une fois). Demandez-en un nouveau.');
  const hash = await bcrypt.hash(pass, sec.BCRYPT_COST);
  db.transaction(() => {
    db.prepare('UPDATE users SET pass_hash = ?, pass_changed_at = ? WHERE id = ?').run(hash, nowISO(), r.user_id);
    db.prepare('UPDATE password_resets SET used_at = ? WHERE user_id = ?').run(nowISO(), r.user_id);
  })();
  sec.audit('password_reset', req, r.user_id, '');
  res.json({ ok: true });
}));

// ---- Changer son mot de passe (connecté) : les autres appareils sont déconnectés ----
router.post('/me/password', requireUser, limits.make(15 * 60 * 1000, 10, 'Trop de tentatives. Réessayez dans quelques minutes.'), asyncHandler(async (req, res) => {
  const b = req.body || {};
  const cur = typeof b.current === 'string' ? b.current.slice(0, 200) : '';
  const pass = typeof b.pass === 'string' ? b.pass : '';
  if (!(await bcrypt.compare(cur, req.user.pass_hash))) { sec.audit('password_change_fail', req, req.user.id, ''); throw new HttpError(403, 'Mot de passe actuel incorrect.'); }
  const pw = sec.passwordProblem(pass, req.user.name, req.user.contact);
  if (pw) throw new HttpError(400, pw);
  if (pass === cur) throw new HttpError(400, 'Le nouveau mot de passe doit être différent de l\'ancien.');
  db.prepare('UPDATE users SET pass_hash = ?, pass_changed_at = ? WHERE id = ?').run(await bcrypt.hash(pass, sec.BCRYPT_COST), nowISO(), req.user.id);
  sec.audit('password_change', req, req.user.id, '');
  setUserCookie(res, req.user.id); // cet appareil reste connecté, les autres non
  if (req.user.contact.includes('@')) mailUser(req.user.contact, 'Votre mot de passe MANAGER-IA a été modifié', `Bonjour ${req.user.name},\n\nVotre mot de passe vient d'être modifié. Si ce n'est pas vous, réinitialisez-le tout de suite depuis la page de connexion (« Mot de passe oublié »).\n\nL'équipe MANAGER-IA`);
  res.json({ ok: true });
}));

router.post('/logout', (req, res) => {
  clearUserCookie(res);
  res.json({ ok: true });
});

router.get('/me', requireUser, (req, res) => res.json({ user: publicUser(req.user) }));

// ---- Sauvegarde de l'état (intérêts, progression, projets) ----
router.put('/me/state', requireUser, (req, res) => {
  const b = req.body || {};
  const u = req.user;
  const interests = b.interests === undefined ? parseJSON(u.interests, []) : cleanInterests(b.interests);
  const progress = b.progress === undefined ? parseJSON(u.progress, {}) : cleanProgress(b.progress);
  const project = b.project === undefined ? parseJSON(u.project, {}) : cleanProject(b.project);

  if (u.plan === 'Gratuit') {
    if (countDomains(interests) > FREE_MAX_DOMAINS) {
      throw new HttpError(403, "L'offre Gratuite donne accès à 2 domaines. Passez à l'offre Pro.");
    }
    // 1 projet guidé par mois : on ne peut pas changer le domaine d'un mois déjà commencé.
    const old = parseJSON(u.project, {});
    for (const k of Object.keys(project)) {
      if (old[k] && old[k].domain !== project[k].domain) {
        throw new HttpError(403, "L'offre Gratuite donne 1 projet guidé par mois. Passez à l'offre Pro pour en faire plus.");
      }
    }
  }

  db.prepare('UPDATE users SET interests = ?, progress = ?, project = ? WHERE id = ?')
    .run(JSON.stringify(interests), JSON.stringify(progress), JSON.stringify(project), u.id);
  res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(u.id)) });
});

module.exports = router;
module.exports.makeResetLink = makeResetLink;
