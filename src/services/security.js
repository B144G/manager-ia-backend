'use strict';
// Sécurité des comptes : règle des mots de passe, verrouillage après échecs répétés, journal de sécurité.
const { db, nowISO } = require('../db');
const { HttpError, log } = require('../util');

const BCRYPT_COST = 12;
const MAX_FAILS = 8;                       // échecs avant verrouillage
const FAIL_WINDOW_MS = 15 * 60 * 1000;     // fenêtre de comptage des échecs
const LOCK_MS = 15 * 60 * 1000;            // durée du verrouillage


// Mots de passe très courants (liste réduite, comparée après retrait des chiffres et symboles de fin et des substitutions « leet »).
const COMMON_WORDS = new Set(('password motdepasse passw0rd azerty azertyuiop qwerty qwertyuiop qwertz abcdef abcdefgh admin administrateur administrator root login welcome bienvenue bonjour bonsoir salut soleil dragon master monkey football foot ' +
  'letmein iloveyou jetaime chocolat doudou princesse cheri cherie camerounais cameroun cameroon douala yaounde bafoussam garoua bamenda limbe kribi lions lionsindomptables brijia brij mabah mabahia manager secret secrets super superman batman azur ' +
  'trustno1 sunshine shadow michael jordan hunter ranger buster thomas robert jessica matthieu nicolas marie maria sandra').split(' '));
const COMMON = new Set(['12345678', '123456789', '1234567890', '0123456789', '987654321', '87654321', 'password', 'password1', 'password123', 'motdepasse', 'motdepasse1', 'azertyui', 'azerty123', 'azerty1234', 'qwertyui', 'qwerty123', 'abcd1234', '11111111', '00000000', 'iloveyou', 'admin123', 'administrateur', 'bienvenue1', 'bonjour123', 'cameroun1', 'cameroun237', 'camer237', 'brijia123', 'welcome1', 'welcome123', 'changeme', 'changez-moi', 'passw0rd']);
const WALKS = ['qwerty', 'azerty', 'wxcvbn', 'asdfgh', 'qsdfgh', 'zxcvbn', '123456', '234567', '345678', '456789', '654321', 'abcdef', 'bcdefg', 'cdefgh'];
const deLeet = (x) => x.replace(/[@4]/g, 'a').replace(/3/g, 'e').replace(/[1!|]/g, 'i').replace(/0/g, 'o').replace(/[$5]/g, 's').replace(/7/g, 't');
const strictMode = () => require('../config').isProd || process.env.PASSWORD_POLICY === 'strict';

/**
 * Vérifie un nouveau mot de passe. Renvoie un message d'erreur, ou '' s'il est correct.
 * Règle de base (toujours) : 8 caractères au moins, pas dans la liste des mots de passe courants, pas répété ni seulement des chiffres, pas le nom ou l'e-mail.
 * Règle stricte (production, ou PASSWORD_POLICY=strict) : 10 caractères au moins, au moins 2 sortes de caractères (ou 16+ caractères), pas de suite évidente
 * (qwerty, 123456, abcdef…), pas un mot courant suivi de chiffres (« Cameroun2024 »).
 */
function passwordProblemWith(strict, pass, ...personal) {
  if (typeof pass !== 'string' || pass.length < 8) return 'Le mot de passe doit contenir au moins 8 caractères.';
  if (pass.length > 200) return 'Le mot de passe est trop long.';
  const low = pass.toLowerCase();
  if (COMMON.has(low) || /^(.)\1+$/.test(pass) || /^\d+$/.test(pass)) return 'Ce mot de passe est trop facile à deviner. Mélangez lettres et chiffres.';
  for (const p of personal) { const x = String(p || '').toLowerCase().split('@')[0]; if (x.length >= 4 && low.includes(x)) return 'Ne mettez pas votre nom ou votre e-mail dans le mot de passe.'; }
  if (!strict) return '';
  if (low === 'secret123' || low === 'secret1234') return 'Ce mot de passe est trop facile à deviner. Mélangez lettres et chiffres.';
  if (pass.length < 10) return 'Le mot de passe doit contenir au moins 10 caractères.';
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(pass)).length;
  if (classes < 2 && pass.length < 16) return 'Mélangez au moins deux sortes de caractères (lettres, chiffres, symboles) ou faites une phrase de 16 caractères.';
  if (WALKS.some((w) => low.includes(w))) return 'Évitez les suites évidentes (qwerty, 123456, abcdef…).';
  const core = deLeet(low).replace(/[^a-z]/g, '');
  const stem = low.replace(/[\d\W_]+$/g, '');
  if (COMMON_WORDS.has(stem) || COMMON_WORDS.has(core) || COMMON_WORDS.has(deLeet(stem).replace(/[^a-z]/g, ''))) return 'Ce mot de passe est trop courant (même avec des chiffres ajoutés). Choisissez une phrase personnelle.';
  return '';
}
const passwordProblem = (pass, ...personal) => passwordProblemWith(strictMode(), pass, ...personal);

/** Lance une erreur 429 si ce compte (ou "admin") est verrouillé. */
async function assertNotLocked(key) {
  const r = await db.prepare('SELECT * FROM login_fails WHERE k = ?').get(key);
  if (r && r.locked_until && Date.parse(r.locked_until) > Date.now()) {
    const min = Math.max(1, Math.ceil((Date.parse(r.locked_until) - Date.now()) / 60000));
    throw new HttpError(429, `Trop d'échecs : connexion bloquée pendant encore ${min} min. Vous pouvez aussi réinitialiser votre mot de passe.`);
  }
}
/** Compte un échec ; renvoie true si le verrouillage vient d'être déclenché. Verrouillage progressif : 15 min, 30 min, 1 h, 2 h… jusqu'à 24 h en cas de récidive. */
async function recordFail(key) {
  const now = Date.now();
  const r = await db.prepare('SELECT * FROM login_fails WHERE k = ?').get(key);
  let fails = 1; let first = new Date(now).toISOString();
  if (r && now - Date.parse(r.first_at) < FAIL_WINDOW_MS) { fails = r.fails + 1; first = r.first_at; }
  // Le niveau retombe à zéro après 24 h sans verrouillage.
  let level = r ? Number(r.lock_level) || 0 : 0;
  if (r && r.locked_until && now - Date.parse(r.locked_until) > 24 * 3600 * 1000) level = 0;
  const lockMs = Math.min(LOCK_MS * 2 ** level, 24 * 3600 * 1000);
  const lock = fails >= MAX_FAILS ? new Date(now + lockMs).toISOString() : null;
  await db.prepare('INSERT INTO login_fails (k, fails, first_at, locked_until, lock_level) VALUES (?, ?, ?, ?, ?) ON CONFLICT(k) DO UPDATE SET fails = excluded.fails, first_at = excluded.first_at, locked_until = excluded.locked_until, lock_level = excluded.lock_level')
    .run(key, lock ? 0 : fails, first, lock, lock ? level + 1 : level);
  return Boolean(lock);
}
const clearFails = async (key) => await db.prepare('DELETE FROM login_fails WHERE k = ?').run(key);

// Anciens types d'événements -> journal d'audit central (src/security/audit.js) : [action, gravité, points d'abus]
const LEGACY = {
  register: ['account.register', 'info'], login_ok: ['login.ok', 'info'], login_fail: ['login.fail', 'warn', 'login_fail'], login_locked: ['login.locked', 'high', 'login_locked'],
  password_reset: ['password.reset', 'warn'], password_change: ['password.change', 'warn'], password_change_fail: ['password.change_fail', 'warn'],
  admin_login: ['admin.login', 'warn'], admin_login_fail: ['admin.login_fail', 'high', 'admin_login_fail'], admin_locked: ['admin.locked', 'critical', 'admin_locked'],
};

/** Journal de sécurité (jamais de mot de passe ni de code) : écrit dans le journal d'audit central, et compte les points d'abus. */
async function audit(type, req, userId, detail) {
  const m = LEGACY[type] || [String(type).replace(/_/g, '.'), 'info'];
  const central = require('../security');
  await central.audit.record(req, m[0], { userId, detail, severity: m[1], actor: type === 'admin_login' ? { type: 'admin', id: null } : undefined });
  if (m[2]) await central.abuse.strike(req, m[2]);
}

async function sweep() {
  await db.prepare('DELETE FROM security_log WHERE at < ?').run(new Date(Date.now() - 180 * 86400000).toISOString());
  await db.prepare('DELETE FROM login_fails WHERE (locked_until IS NULL OR locked_until < ?) AND first_at < ? AND (lock_level = 0 OR locked_until < ?)').run(nowISO(), new Date(Date.now() - FAIL_WINDOW_MS).toISOString(), new Date(Date.now() - 24 * 3600 * 1000).toISOString());
  await require('../security').sweep();
}

module.exports = { BCRYPT_COST, passwordProblem, passwordProblemWith, assertNotLocked, recordFail, clearFails, audit, sweep };
