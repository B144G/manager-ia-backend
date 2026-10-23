'use strict';
// Comptes : inscription, connexion, profil, sauvegarde de la progression.
const express = require('express');
const bcrypt = require('bcryptjs');
const { db, nowISO, publicUser, getUserFresh } = require('../db');
const limits = require('../middleware/limits');
const jwt = require('jsonwebtoken');
const { setUserCookie, clearUserCookie, requireUser, sessionIdOf, USER_COOKIE } = require('../middleware/auth');
const central = require('../security');
const { notify } = require('../services/notify');
const { asyncHandler, HttpError, normalizeContact, cleanText, parseJSON } = require('../util');

const router = express.Router();
const crypto = require('crypto');
const config = require('../config');
const { mailUser, mailEnabled, sendMail } = require('../services/notify');
const sec = require('../services/security');

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
// Avec la vérification (par défaut dès que les e-mails sont configurés) : on envoie un code à 6 chiffres valable 1 minute ;
// le compte n'est créé qu'après saisie du bon code. Sans e-mail configuré (essais en local), l'inscription reste directe.
const CODE_MS = 60 * 1000;          // durée de vie du code
const RESEND_MS = 20 * 1000;        // attente avant de pouvoir redemander un code
const MAX_TRIES = 5;                // essais par code
const MAX_SENDS = 5;                // codes par heure et par adresse
const verifyOn = () => config.signupVerify === 'on' || (config.signupVerify !== 'off' && mailEnabled());
const codeHash = (contact, code) => crypto.createHmac('sha256', config.jwtSecret).update(`${contact}|${code}`).digest('hex');
const maskMail = (m) => m.replace(/^(.).*(@.*)$/, '$1***$2');

async function sendSignupCode(row, name) {
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const now = Date.now();
  const sent = await sendMail({
    to: row.contact,
    subject: 'Votre code de vérification MANAGER-IA',
    text: `Bonjour ${name},\n\nVotre code de vérification : ${code}\n\nIl est valable 1 minute. Saisissez-le sur la page d'inscription pour terminer la création de votre compte.\n\nSi vous n'avez pas demandé ce code, ignorez ce message.\n\nL'équipe MANAGER-IA`,
  });
  if (!sent) throw new HttpError(503, "L'envoi d'e-mails n'est pas disponible pour le moment. Réessayez plus tard.");
  return { codeHash: codeHash(row.contact, code), expires: new Date(now + CODE_MS).toISOString(), at: new Date(now).toISOString() };
}
const sweepCodes = async () => await db.prepare('DELETE FROM signup_codes WHERE expires_at < ?').run(new Date(Date.now() - 10 * 60 * 1000).toISOString());

async function createUser(req, res, { name, contact, hash, interests }) {
  const dup = 'Un compte existe déjà avec ce contact. Utilisez « Me connecter ».';
  let id;
  try {
    id = (await db.prepare('INSERT INTO users (name, contact, pass_hash, interests, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(name, contact, hash, JSON.stringify(interests), nowISO())).lastInsertRowid;
  } catch (e) {
    if (e.code === '23505') throw new HttpError(409, dup);
    throw e;
  }
  await setUserCookie(res, Number(id), req);
  await sec.audit('register', null, Number(id), '');
  notify('inscription', `Nouvelle inscription : ${name} (${contact}) - intérêts : ${interests.join(', ') || 'aucun'}`);
  return publicUser(await db.prepare('SELECT * FROM users WHERE id = ?').get(id));
}

router.get('/register/info', (req, res) => res.json({ verify: verifyOn() }));

router.post('/register', limits.register, asyncHandler(async (req, res) => {
  const b = req.body || {};
  const name = cleanText(b.name, 100);
  const contact = normalizeContact(b.contact);
  const pass = typeof b.pass === 'string' ? b.pass : '';
  if (name.length < 2) throw new HttpError(400, 'Veuillez indiquer votre nom.');
  if (!contact) throw new HttpError(400, 'Contact invalide : entrez un e-mail ou un numéro de téléphone valide.');
  const pw = sec.passwordProblem(pass, name, contact.value);
  if (pw) throw new HttpError(400, pw);
  let interests = b.interests === undefined ? [] : cleanInterests(b.interests);
  // Offre Gratuite : 2 domaines maximum dès l'inscription (on garde les 2 premiers).
  let kept = 0;
  interests = interests.filter((i) => !DOMAINS.includes(i) || ++kept <= FREE_MAX_DOMAINS);

  const dup = 'Un compte existe déjà avec ce contact. Utilisez « Me connecter ».';
  if (await db.prepare('SELECT 1 FROM users WHERE contact = ?').get(contact.value)) throw new HttpError(409, dup);

  const hash = await bcrypt.hash(pass, sec.BCRYPT_COST);
  if (!verifyOn()) return res.status(201).json({ user: await createUser(req, res, { name, contact: contact.value, hash, interests }) });

  if (!contact.value.includes('@')) throw new HttpError(400, 'Entrez une adresse e-mail : nous vous y envoyons un code de vérification.');
  await sweepCodes();
  const prev = await db.prepare('SELECT * FROM signup_codes WHERE contact = ?').get(contact.value);
  const now = Date.now();
  const fresh = prev && now - Date.parse(prev.window_start) < 3600 * 1000;
  if (fresh && prev.sends >= MAX_SENDS) throw new HttpError(429, 'Trop de codes demandés pour cette adresse. Réessayez dans une heure.');
  const sent = await sendSignupCode({ contact: contact.value }, name);
  await db.prepare(`INSERT INTO signup_codes (contact, name, pass_hash, interests, code_hash, expires_at, attempts, sent_at, sends, window_start)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
    ON CONFLICT(contact) DO UPDATE SET name = excluded.name, pass_hash = excluded.pass_hash, interests = excluded.interests, code_hash = excluded.code_hash,
      expires_at = excluded.expires_at, attempts = 0, sent_at = excluded.sent_at, sends = excluded.sends, window_start = excluded.window_start`)
    .run(contact.value, name, hash, JSON.stringify(interests), sent.codeHash, sent.expires, sent.at, fresh ? prev.sends + 1 : 1, fresh ? prev.window_start : sent.at);
  res.status(202).json({ verify: true, contact: maskMail(contact.value), expiresIn: CODE_MS / 1000, resendIn: RESEND_MS / 1000 });
}));

router.post('/register/resend', limits.make(15 * 60 * 1000, 20, 'Trop de demandes. Réessayez dans quelques minutes.'), asyncHandler(async (req, res) => {
  const contact = normalizeContact((req.body || {}).contact);
  const row = contact && verifyOn() ? await db.prepare('SELECT * FROM signup_codes WHERE contact = ?').get(contact.value) : null;
  if (!row) throw new HttpError(400, 'Aucune inscription en attente pour cette adresse. Recommencez l\'inscription.');
  const wait = RESEND_MS - (Date.now() - Date.parse(row.sent_at));
  if (wait > 0) throw new HttpError(429, `Patientez ${Math.ceil(wait / 1000)} s avant de redemander un code.`);
  const fresh = Date.now() - Date.parse(row.window_start) < 3600 * 1000;
  if (fresh && row.sends >= MAX_SENDS) throw new HttpError(429, 'Trop de codes demandés pour cette adresse. Réessayez dans une heure.');
  const sent = await sendSignupCode(row, row.name);
  await db.prepare('UPDATE signup_codes SET code_hash = ?, expires_at = ?, attempts = 0, sent_at = ?, sends = ?, window_start = ? WHERE contact = ?')
    .run(sent.codeHash, sent.expires, sent.at, fresh ? row.sends + 1 : 1, fresh ? row.window_start : sent.at, row.contact);
  res.json({ ok: true, expiresIn: CODE_MS / 1000, resendIn: RESEND_MS / 1000 });
}));

router.post('/register/verify', limits.make(15 * 60 * 1000, 40, 'Trop de tentatives. Réessayez dans quelques minutes.', { shared: true, prefix: 'regverify' }), asyncHandler(async (req, res) => {
  const b = req.body || {};
  const contact = normalizeContact(b.contact);
  const code = typeof b.code === 'string' ? b.code.replace(/\s/g, '') : '';
  const row = contact ? await db.prepare('SELECT * FROM signup_codes WHERE contact = ?').get(contact.value) : null;
  if (!row) throw new HttpError(400, 'Aucune inscription en attente pour cette adresse. Recommencez l\'inscription.');
  if (!/^\d{6}$/.test(code)) throw new HttpError(400, 'Entrez le code à 6 chiffres reçu par e-mail.');
  if (Date.parse(row.expires_at) < Date.now()) throw new HttpError(400, 'Ce code a expiré (il dure 1 minute). Demandez-en un nouveau.');
  if (row.attempts >= MAX_TRIES) throw new HttpError(429, 'Trop d\'essais pour ce code. Demandez-en un nouveau.');
  const a = Buffer.from(codeHash(row.contact, code), 'hex');
  const ok = crypto.timingSafeEqual(a, Buffer.from(row.code_hash, 'hex'));
  if (!ok) {
    await db.prepare('UPDATE signup_codes SET attempts = attempts + 1 WHERE contact = ?').run(row.contact);
    throw new HttpError(400, 'Code incorrect.');
  }
  const user = await db.transaction(async () => {
    const u = await createUser(req, res, { name: row.name, contact: row.contact, hash: row.pass_hash, interests: parseJSON(row.interests, []) });
    await db.prepare('DELETE FROM signup_codes WHERE contact = ?').run(row.contact);
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
  if (key) await sec.assertNotLocked(key);
  const row = contact ? await db.prepare('SELECT * FROM users WHERE contact = ?').get(contact.value) : null;
  const ok = await bcrypt.compare(pass, row ? row.pass_hash : DUMMY_HASH); // même durée si le compte n'existe pas
  if (!row || !ok) {
    if (key && await sec.recordFail(key)) await sec.audit('login_locked', req, row && row.id, 'verrouillage 15 min');
    else await sec.audit('login_fail', req, row && row.id, '');
    throw fail;
  }
  await sec.clearFails(key);
  if (Number(row.totp_enabled)) {
    // Mot de passe juste, mais la double authentification est active : on attend le code (étape valable 5 minutes, aucun cookie pour l'instant).
    const ticket = jwt.sign({ typ: 'tfa', sub: row.id }, config.jwtSecret, { algorithm: 'HS256', expiresIn: '5m' });
    return res.json({ twofa: true, ticket });
  }
  await sec.audit('login_ok', req, row.id, '');
  await setUserCookie(res, row.id, req);
  res.json({ user: publicUser(await getUserFresh(row.id)) });
}));

// ---- Connexion, étape 2 : code de l'application d'authentification (ou code de secours) ----
router.post('/login/2fa', limits.twofa, asyncHandler(async (req, res) => {
  const b = req.body || {};
  let p = null;
  try { p = jwt.verify(String(b.ticket || ''), config.jwtSecret, { algorithms: ['HS256'] }); } catch { p = null; }
  if (!p || p.typ !== 'tfa') throw new HttpError(401, 'Cette étape a expiré : recommencez la connexion.');
  const key = 't:' + p.sub;
  await sec.assertNotLocked(key);
  const row = await db.prepare('SELECT * FROM users WHERE id = ?').get(p.sub);
  if (!row || !Number(row.totp_enabled)) throw new HttpError(401, 'Cette étape a expiré : recommencez la connexion.');
  const code = String(b.code || '').trim().slice(0, 20);
  let ok = false;
  const step = central.totp.verify(central.totp.unseal(row.totp_secret), code, row.totp_step);
  if (step) { ok = true; await db.prepare('UPDATE users SET totp_step = ? WHERE id = ?').run(step, row.id); }
  else {
    const left = central.totp.useRecovery(row.recovery_codes, code);
    if (left !== null) { ok = true; await db.prepare('UPDATE users SET recovery_codes = ? WHERE id = ?').run(left, row.id); await central.audit.record(req, 'twofa.recovery_used', { userId: row.id, severity: 'warn', detail: `${central.totp.recoveryLeft(left)} code(s) de secours restant(s)` }); }
  }
  if (!ok) {
    const locked = await sec.recordFail(key);
    await central.audit.record(req, locked ? 'twofa.locked' : 'twofa.fail', { userId: row.id, severity: locked ? 'high' : 'warn' });
    await central.abuse.strike(req, 'twofa_fail');
    throw new HttpError(401, 'Code incorrect ou expiré.');
  }
  await sec.clearFails(key);
  await sec.audit('login_ok', req, row.id, '2FA');
  await setUserCookie(res, row.id, req);
  res.json({ user: publicUser(await getUserFresh(row.id)) });
}));

// ---- Mot de passe oublié ----
// Réponse toujours identique (on ne révèle pas si un compte existe). Compte avec e-mail et envoi d'e-mails activé : lien envoyé par e-mail.
// Sinon (téléphone) : l'administrateur est prévenu et envoie lui-même un lien (valable 1 h, usage unique) après avoir vérifié la personne.
const RESET_MS = 60 * 60 * 1000;
const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');
async function makeResetLink(req, userId, by) {
  const token = crypto.randomBytes(32).toString('hex');
  await db.prepare("DELETE FROM password_resets WHERE user_id = ? AND used_at IS NULL").run(userId);
  await db.prepare('INSERT INTO password_resets (user_id, token_hash, expires_at, created_by, created_at) VALUES (?, ?, ?, ?, ?)').run(userId, hashToken(token), new Date(Date.now() + RESET_MS).toISOString(), by, nowISO());
  const base = (config.siteUrl || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
  return { link: `${base}/reinitialiser?t=${token}`, expiresAt: new Date(Date.now() + RESET_MS).toISOString() };
}
router.post('/password/forgot', limits.make(15 * 60 * 1000, 6, 'Trop de demandes. Réessayez dans quelques minutes.', { shared: true, prefix: 'pwforgot' }), async (req, res) => {
  const contact = normalizeContact((req.body || {}).contact);
  const row = contact ? await db.prepare('SELECT * FROM users WHERE contact = ?').get(contact.value) : null;
  if (row) {
    if (row.contact.includes('@') && mailEnabled()) {
      const { link } = await makeResetLink(req, row.id, 'user');
      mailUser(row.contact, 'Réinitialisation de votre mot de passe - MANAGER-IA', `Bonjour ${row.name},\n\nVous avez demandé à changer votre mot de passe. Ouvrez ce lien (valable 1 heure, une seule fois) :\n${link}\n\nSi vous n'êtes pas à l'origine de cette demande, ignorez ce message : votre mot de passe reste inchangé.\n\nL'équipe MANAGER-IA`);
    } else {
      notify('reinitialisation', `Demande de réinitialisation de mot de passe : ${row.name} (${row.contact}). Vérifiez la personne, puis générez un lien dans Administration > Utilisateurs.`);
    }
  }
  res.json({ ok: true, message: "Si un compte existe avec ce contact, vous allez recevoir un lien par e-mail. Pour un compte avec téléphone, l'équipe vous contactera pour vérifier votre identité." });
});
router.post('/password/reset', limits.make(15 * 60 * 1000, 10, 'Trop de tentatives. Réessayez dans quelques minutes.', { shared: true, prefix: 'pwreset' }), asyncHandler(async (req, res) => {
  const b = req.body || {};
  const token = typeof b.token === 'string' ? b.token.slice(0, 100) : '';
  const pass = typeof b.pass === 'string' ? b.pass : '';
  const pw = sec.passwordProblem(pass);
  if (pw) throw new HttpError(400, pw);
  const r = /^[a-f0-9]{64}$/.test(token) ? await db.prepare('SELECT * FROM password_resets WHERE token_hash = ?').get(hashToken(token)) : null;
  if (!r || r.used_at || Date.parse(r.expires_at) < Date.now()) throw new HttpError(400, 'Ce lien n\'est plus valable (il dure 1 heure et ne sert qu\'une fois). Demandez-en un nouveau.');
  const hash = await bcrypt.hash(pass, sec.BCRYPT_COST);
  await db.transaction(async () => {
    await db.prepare('UPDATE users SET pass_hash = ?, pass_changed_at = ? WHERE id = ?').run(hash, nowISO(), r.user_id);
    await db.prepare('UPDATE password_resets SET used_at = ? WHERE user_id = ?').run(nowISO(), r.user_id);
  })();
  await sec.audit('password_reset', req, r.user_id, '');
  await central.sessions.revokeAllForUser(r.user_id, '', 'mot de passe réinitialisé');
  res.json({ ok: true });
}));

// ---- Changer son mot de passe (connecté) : les autres appareils sont déconnectés ----
router.post('/me/password', requireUser, limits.make(15 * 60 * 1000, 10, 'Trop de tentatives. Réessayez dans quelques minutes.', { shared: true, prefix: 'pwchange' }), asyncHandler(async (req, res) => {
  const b = req.body || {};
  const cur = typeof b.current === 'string' ? b.current.slice(0, 200) : '';
  const pass = typeof b.pass === 'string' ? b.pass : '';
  if (!(await bcrypt.compare(cur, req.user.pass_hash))) { await sec.audit('password_change_fail', req, req.user.id, ''); throw new HttpError(403, 'Mot de passe actuel incorrect.'); }
  const pw = sec.passwordProblem(pass, req.user.name, req.user.contact);
  if (pw) throw new HttpError(400, pw);
  if (pass === cur) throw new HttpError(400, 'Le nouveau mot de passe doit être différent de l\'ancien.');
  await db.prepare('UPDATE users SET pass_hash = ?, pass_changed_at = ? WHERE id = ?').run(await bcrypt.hash(pass, sec.BCRYPT_COST), nowISO(), req.user.id);
  await sec.audit('password_change', req, req.user.id, '');
  await setUserCookie(res, req.user.id, req, { closeOthers: true }); // cet appareil reste connecté, les autres sont déconnectés immédiatement
  if (req.user.contact.includes('@')) mailUser(req.user.contact, 'Votre mot de passe MANAGER-IA a été modifié', `Bonjour ${req.user.name},\n\nVotre mot de passe vient d'être modifié. Si ce n'est pas vous, réinitialisez-le tout de suite depuis la page de connexion (« Mot de passe oublié »).\n\nL'équipe MANAGER-IA`);
  res.json({ ok: true });
}));

router.post('/logout', async (req, res) => {
  const sid = sessionIdOf(req, USER_COOKIE, 'user');
  if (sid) await central.sessions.revoke(sid, 'déconnexion');
  clearUserCookie(res);
  res.json({ ok: true });
});

router.get('/me', requireUser, (req, res) => res.json({ user: publicUser(req.user) }));

// ---- Sauvegarde de l'état (intérêts, progression, projets) ----
router.put('/me/state', requireUser, async (req, res) => {
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

  await db.prepare('UPDATE users SET interests = ?, progress = ?, project = ? WHERE id = ?')
    .run(JSON.stringify(interests), JSON.stringify(progress), JSON.stringify(project), u.id);
  res.json({ user: publicUser(await db.prepare('SELECT * FROM users WHERE id = ?').get(u.id)) });
});

module.exports = router;
module.exports.makeResetLink = makeResetLink;
