'use strict';
// Connexion employé (compte d'entreprise, étape 2) : code d'entreprise + e-mail + secret personnel (mot de passe ou PIN), appareils de confiance,
// double authentification des profils sensibles. L'ancienne connexion (contact + mot de passe, /api/login) reste en parallèle, inchangée.
// Messages d'erreur toujours clairs et en français, jamais d'erreur brute ; on ne révèle jamais si un code, un e-mail ou une personne existe.
const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { db, nowISO, publicUser, getUserFresh } = require('../db');
const limits = require('../middleware/limits');
const config = require('../config');
const { setUserCookie, requireUser } = require('../middleware/auth');
const sec = require('../services/security');
const central = require('../security');
const sessions = require('../security/sessions');
const accounts = require('../services/accounts');
const L = require('../workspace/ent-auth-lib');
const { asyncHandler, HttpError, cleanText } = require('../util');

const router = express.Router();
const DEV_COOKIE = 'mia_dev';
const DUMMY = bcrypt.hashSync('secret-factice-entreprise', sec.BCRYPT_COST);
const GENERIC = "Code d'entreprise, e-mail ou secret incorrect. Vérifiez vos informations ou demandez de l'aide à votre administrateur.";
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const rl = (n, prefix) => limits.make(15 * 60 * 1000, n, 'Trop de tentatives. Réessayez dans quelques minutes.', { shared: true, prefix });
const cookieOpts = (maxAge) => ({ httpOnly: true, secure: config.cookie.secure, sameSite: config.cookie.sameSite, path: '/', maxAge });
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');

/** Vérifie la forme du secret : mot de passe (règles habituelles) ou PIN de 6 à 8 chiffres (pas de suite ni de répétition évidentes). */
function secretProblem(method, secret, name, email) {
  if (method === 'pin') {
    const s = String(secret || '');
    if (!/^\d{6,8}$/.test(s)) return 'Le code PIN compte 6 à 8 chiffres.';
    if (/^(\d)\1+$/.test(s) || '0123456789012345'.includes(s) || '9876543210987654'.includes(s) || /^(\d\d)\1+$/.test(s)) return 'Ce code PIN est trop facile à deviner : évitez les suites et les répétitions.';
    return '';
  }
  return sec.passwordProblem(secret, name, email);
}
const methodOf = (v) => { if (v !== 'password' && v !== 'pin') throw new HttpError(400, 'Choisissez un mot de passe ou un code PIN.'); return v; };
const trustOf = (v) => { if (v === undefined || v === null || v === '' || v === false || Number(v) === 0) return 0; const n = Number(v); if (!Number.isFinite(n)) return 0; return Math.min(Math.max(Math.round(n), 30), 90); };

async function entByCode(code) {
  const c = L.normCode(code);
  return c.length >= 4 ? db.prepare('SELECT * FROM entreprises WHERE company_code = ?').get(c) : null;
}

/** Ouvre la session, crée si demandé l'appareil de confiance, et renvoie ce que le site doit savoir (organisation, rôle, poste). */
async function complete(req, res, { user, person, ent, trustDays }) {
  const sid = await setUserCookie(res, user.id, req);
  await db.prepare('UPDATE ent_credentials SET last_login_at = ? WHERE person_id = ?').run(nowISO(), person.id);
  let device = null;
  if (trustDays) {
    const token = crypto.randomBytes(32).toString('hex');
    const now = nowISO();
    const id = (await db.prepare('INSERT INTO ent_devices (person_id, user_id, token_hash, label, ip, session_id, created_at, last_seen, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(person.id, user.id, sha(token), sessions.deviceName(req.get('user-agent')), String(req.ip || '').slice(0, 64), sid, now, now, new Date(Date.now() + trustDays * 86400000).toISOString())).lastInsertRowid;
    res.cookie(DEV_COOKIE, `${id}.${token}`, cookieOpts(trustDays * 86400000));
    device = { id: Number(id), days: trustDays };
  }
  await sec.audit('login_ok', req, user.id, 'connexion employé');
  return { user: publicUser(await getUserFresh(user.id)), landing: await L.landingFor(ent.id, user.id), device, company: { name: ent.name } };
}

// ---------- Connexion ----------
router.post('/login', rl(40, 'entlogin'), asyncHandler(async (req, res) => {
  const b = req.body || {};
  const email = cleanText(b.email, 120).toLowerCase();
  const secret = typeof b.secret === 'string' ? b.secret.slice(0, 200) : '';
  const ent = await entByCode(b.companyCode);
  const person = ent && EMAIL.test(email) ? await db.prepare("SELECT * FROM ent_people WHERE entreprise_id = ? AND lower(email) = ? AND user_id IS NOT NULL AND status = 'active'").get(ent.id, email) : null;
  const key = ent ? `e:${ent.id}:${email}` : '';
  if (key) await sec.assertNotLocked(key);
  const cred = person ? await db.prepare('SELECT * FROM ent_credentials WHERE person_id = ?').get(person.id) : null;
  const ok = await bcrypt.compare(secret, cred ? cred.secret_hash : DUMMY); // même durée que le compte existe ou non
  if (!person || !cred || !ok) {
    if (key && await sec.recordFail(key)) await sec.audit('login_locked', req, person && person.user_id, 'verrouillage 15 min (connexion employé)');
    else await sec.audit('login_fail', req, person && person.user_id, 'connexion employé');
    throw new HttpError(401, GENERIC);
  }
  await sec.clearFails(key);
  const user = await getUserFresh(person.user_id);
  if (!user) throw new HttpError(401, GENERIC);
  accounts.assertNotSuspended(user);
  const trustDays = trustOf(b.trustDays);
  if (Number(user.totp_enabled)) {
    const ticket = jwt.sign({ typ: 'etfa', sub: user.id, p: person.id, e: ent.id, t: trustDays }, config.jwtSecret, { algorithm: 'HS256', expiresIn: '5m' });
    return res.json({ twofa: true, ticket });
  }
  res.json(await complete(req, res, { user, person, ent, trustDays }));
}));

router.post('/login/2fa', limits.twofa, asyncHandler(async (req, res) => {
  const b = req.body || {};
  let p = null;
  try { p = jwt.verify(String(b.ticket || ''), config.jwtSecret, { algorithms: ['HS256'] }); } catch { p = null; }
  if (!p || p.typ !== 'etfa') throw new HttpError(401, 'Cette étape a expiré : recommencez la connexion.');
  const key = 't:' + p.sub;
  await sec.assertNotLocked(key);
  const row = await db.prepare('SELECT * FROM users WHERE id = ?').get(p.sub);
  if (!row || !Number(row.totp_enabled)) throw new HttpError(401, 'Cette étape a expiré : recommencez la connexion.');
  accounts.assertNotSuspended(row);
  const code = String(b.code || '').trim().slice(0, 20);
  let ok = false;
  const step = central.totp.verify(central.totp.unseal(row.totp_secret), code, row.totp_step);
  if (step) { ok = true; await db.prepare('UPDATE users SET totp_step = ? WHERE id = ?').run(step, row.id); }
  else { const left = central.totp.useRecovery(row.recovery_codes, code); if (left !== null) { ok = true; await db.prepare('UPDATE users SET recovery_codes = ? WHERE id = ?').run(left, row.id); } }
  if (!ok) {
    const locked = await sec.recordFail(key);
    await central.audit.record(req, locked ? 'twofa.locked' : 'twofa.fail', { userId: row.id, severity: locked ? 'high' : 'warn' });
    throw new HttpError(401, 'Code incorrect ou expiré.');
  }
  await sec.clearFails(key);
  const person = await db.prepare('SELECT * FROM ent_people WHERE id = ?').get(p.p);
  const ent = await db.prepare('SELECT * FROM entreprises WHERE id = ?').get(p.e);
  if (!person || !ent) throw new HttpError(401, 'Cette étape a expiré : recommencez la connexion.');
  res.json(await complete(req, res, { user: row, person, ent, trustDays: p.t || 0 }));
}));

// ---------- Première connexion : l'invitation personnelle devient un compte ----------
router.post('/activate', rl(20, 'entactivate'), asyncHandler(async (req, res) => {
  const b = req.body || {};
  const ent = await entByCode(b.companyCode);
  const inviteCode = cleanText(b.inviteCode, 40).toUpperCase();
  const email = cleanText(b.email, 120).toLowerCase();
  const bad = new HttpError(400, "Code d'entreprise ou code d'invitation invalide, ou déjà utilisé. Demandez un nouveau code à votre administrateur.");
  if (!ent || !inviteCode) throw bad;
  if (!EMAIL.test(email)) throw new HttpError(400, 'Entrez une adresse e-mail valide : elle sert d\'identifiant de connexion.');
  const person = await db.prepare('SELECT * FROM ent_people WHERE entreprise_id = ? AND invite_code = ? AND user_id IS NULL').get(ent.id, inviteCode);
  const inv = person ? await db.prepare('SELECT * FROM invites WHERE code = ? AND org_id = ?').get(inviteCode, person.invite_org_id) : null;
  if (!person || !inv || Date.parse(inv.expires_at) < Date.now()) throw bad;
  if (person.email && person.email.toLowerCase() !== email) throw new HttpError(400, "Cette adresse e-mail ne correspond pas à celle prévue pour cette invitation. Utilisez l'adresse que votre administrateur a saisie.");
  const method = methodOf(b.method);
  const secret = typeof b.secret === 'string' ? b.secret : '';
  const problem = secretProblem(method, secret, person.full_name, email);
  if (problem) throw new HttpError(400, problem);
  if (await db.prepare('SELECT 1 FROM users WHERE contact = ?').get(email)) throw new HttpError(409, "Un compte existe déjà avec cet e-mail. Connectez-vous avec votre mot de passe, puis rejoignez l'entreprise avec votre code d'invitation.");
  const org = await db.prepare('SELECT * FROM orgs WHERE id = ?').get(inv.org_id);
  const A = require('../workspace/access');
  if (Number((await db.prepare('SELECT COUNT(*) c FROM org_members WHERE org_id = ?').get(org.id)).c) >= A.limitsFor(await A.ownerPlan(org)).members) throw new HttpError(403, "Cette organisation a atteint le nombre de personnes permis par son offre. Prévenez votre administrateur.");
  const hash = await bcrypt.hash(secret, sec.BCRYPT_COST);
  const userHash = method === 'password' ? hash : await bcrypt.hash(crypto.randomBytes(24).toString('hex'), sec.BCRYPT_COST); // un PIN ne devient jamais un mot de passe de l'ancienne connexion
  const now = nowISO();
  const userId = await db.transaction(async () => {
    const uid = Number((await db.prepare('INSERT INTO users (name, contact, pass_hash, interests, created_at) VALUES (?, ?, ?, ?, ?)').run(person.full_name, email, userHash, '[]', now)).lastInsertRowid);
    await db.prepare('INSERT INTO org_members (org_id, user_id, role, title, branch_id, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(org.id, uid, inv.role, inv.title, inv.branch_id, now);
    await db.prepare('DELETE FROM invites WHERE id = ?').run(inv.id);
    await db.prepare("UPDATE ent_people SET user_id = ?, email = ?, status = 'active', invite_code = NULL WHERE id = ?").run(uid, email, person.id);
    await db.prepare('INSERT INTO ent_credentials (person_id, method, secret_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(person.id, method, hash, now, now);
    return uid;
  })();
  await sec.audit('register', req, userId, 'activation par invitation d\'entreprise');
  await accounts.recordEvent(userId, 'inscription');
  const user = await getUserFresh(userId);
  res.status(201).json(await complete(req, res, { user, person: { ...person, id: person.id }, ent, trustDays: trustOf(b.trustDays) }));
}));

// ---------- Appareil de confiance : retour automatique sans ressaisie ----------
router.post('/resume', rl(60, 'entresume'), asyncHandler(async (req, res) => {
  const raw = String((req.cookies && req.cookies[DEV_COOKIE]) || '');
  const m = /^(\d{1,12})\.([a-f0-9]{64})$/.exec(raw);
  const none = () => res.json({ ok: false }); // jamais d'erreur : la page de connexion s'affiche simplement
  if (!m) return none();
  const d = await db.prepare('SELECT * FROM ent_devices WHERE id = ?').get(Number(m[1]));
  const good = d && !d.revoked_at && Date.parse(d.expires_at) > Date.now() && crypto.timingSafeEqual(Buffer.from(sha(m[2])), Buffer.from(d.token_hash));
  if (!good) { res.clearCookie(DEV_COOKIE, { ...cookieOpts(0), maxAge: undefined }); return none(); }
  const user = await getUserFresh(d.user_id);
  const person = await db.prepare("SELECT * FROM ent_people WHERE id = ? AND status = 'active'").get(d.person_id);
  const cred = person ? await db.prepare('SELECT 1 FROM ent_credentials WHERE person_id = ?').get(person.id) : null;
  if (!user || !person || !cred || user.suspended_at) return none();
  const ent = await db.prepare('SELECT * FROM entreprises WHERE id = ?').get(person.entreprise_id);
  const sid = await setUserCookie(res, user.id, req);
  await db.prepare('UPDATE ent_devices SET last_seen = ?, session_id = ?, ip = ? WHERE id = ?').run(nowISO(), sid, String(req.ip || '').slice(0, 64), d.id);
  await sec.audit('login_ok', req, user.id, 'appareil de confiance');
  res.json({ ok: true, user: publicUser(user), landing: await L.landingFor(ent.id, user.id), company: { name: ent.name } });
}));

// ---------- Changer ou créer son secret personnel (personne déjà dans l'entreprise) ----------
router.put('/secret', requireUser, rl(20, 'entsecret'), asyncHandler(async (req, res) => {
  const b = req.body || {};
  const person = await db.prepare('SELECT p.* FROM ent_people p JOIN orgs o ON o.entreprise_id = p.entreprise_id JOIN org_members m ON m.org_id = o.id AND m.user_id = p.user_id WHERE o.id = ? AND p.user_id = ?').get(Number(b.orgId) || 0, req.user.id);
  if (!person) throw new HttpError(404, 'Entreprise introuvable.');
  const cred = await db.prepare('SELECT * FROM ent_credentials WHERE person_id = ?').get(person.id);
  const current = typeof b.current === 'string' ? b.current.slice(0, 200) : '';
  const ok = await bcrypt.compare(current, cred ? cred.secret_hash : req.user.pass_hash);
  if (!ok) { await sec.audit('password_change_fail', req, req.user.id, 'secret employé'); throw new HttpError(403, 'Votre secret actuel (ou mot de passe) est incorrect.'); }
  const method = methodOf(b.method);
  const problem = secretProblem(method, b.secret, req.user.name, req.user.contact);
  if (problem) throw new HttpError(400, problem);
  if (!person.email) await db.prepare('UPDATE ent_people SET email = ? WHERE id = ?').run(req.user.contact.includes('@') ? req.user.contact : '', person.id);
  const now = nowISO(); const hash = await bcrypt.hash(b.secret, sec.BCRYPT_COST);
  await db.prepare(`INSERT INTO ent_credentials (person_id, method, secret_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (person_id) DO UPDATE SET method = EXCLUDED.method, secret_hash = EXCLUDED.secret_hash, updated_at = EXCLUDED.updated_at`).run(person.id, method, hash, now, now);
  await db.prepare('UPDATE ent_devices SET revoked_at = ?, revoked_by = ? WHERE person_id = ? AND revoked_at IS NULL').run(now, 'secret changé', person.id); // un nouveau secret ferme les appareils de confiance
  await sec.audit('password_change', req, req.user.id, 'secret employé');
  res.json({ ok: true, hasCompanyLogin: true, email: person.email || req.user.contact });
}));

// ---------- Appareils de confiance : liste et révocation par la personne ----------
const devView = (d, cur) => ({ id: Number(d.id), label: d.label, createdAt: d.created_at, lastSeen: d.last_seen, expiresAt: d.expires_at, current: cur === Number(d.id) });
const curDev = (req) => { const m = /^(\d{1,12})\./.exec(String((req.cookies && req.cookies[DEV_COOKIE]) || '')); return m ? Number(m[1]) : 0; };
async function revokeDevice(d, by) {
  await db.prepare('UPDATE ent_devices SET revoked_at = ?, revoked_by = ? WHERE id = ? AND revoked_at IS NULL').run(nowISO(), by, d.id);
  if (d.session_id) await sessions.revoke(d.session_id, 'appareil révoqué');
}
router.get('/devices', requireUser, asyncHandler(async (req, res) => {
  const rows = await db.prepare('SELECT * FROM ent_devices WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY last_seen DESC').all(req.user.id, nowISO());
  const cred = await db.prepare('SELECT c.method FROM ent_credentials c JOIN ent_people p ON p.id = c.person_id WHERE p.user_id = ? LIMIT 1').get(req.user.id);
  res.json({ devices: rows.map((d) => devView(d, curDev(req))), hasCompanyLogin: Boolean(cred), method: cred ? cred.method : null });
}));
router.delete('/devices/:id', requireUser, asyncHandler(async (req, res) => {
  const d = await db.prepare('SELECT * FROM ent_devices WHERE id = ? AND user_id = ?').get(Number(req.params.id) || 0, req.user.id);
  if (!d) throw new HttpError(404, 'Appareil introuvable.');
  await revokeDevice(d, 'personne');
  if (curDev(req) === Number(d.id)) res.clearCookie(DEV_COOKIE, { ...cookieOpts(0), maxAge: undefined });
  res.json({ ok: true });
}));
router.delete('/devices', requireUser, asyncHandler(async (req, res) => {
  for (const d of await db.prepare('SELECT * FROM ent_devices WHERE user_id = ? AND revoked_at IS NULL').all(req.user.id)) await revokeDevice(d, 'personne');
  res.clearCookie(DEV_COOKIE, { ...cookieOpts(0), maxAge: undefined });
  res.json({ ok: true });
}));

module.exports = { router, revokeDevice, DEV_COOKIE };
