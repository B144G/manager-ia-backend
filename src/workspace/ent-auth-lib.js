'use strict';
// Compte d'entreprise, étape 2 : code d'entreprise, personnes « sensibles » (double authentification), choix de l'organisation à l'ouverture.
const crypto = require('crypto');
const { db } = require('../db');
const { parseJSON } = require('../util');

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sans O, 0, I, 1 : pas de confusion à la saisie
const newCode = () => { let s = ''; for (let i = 0; i < 6; i++) s += ALPHABET[crypto.randomInt(0, ALPHABET.length)]; return s; };
const normCode = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
const display = (c) => (c ? c.slice(0, 3) + '-' + c.slice(3) : '');

/** Code d'entreprise (créé à la demande, unique). Sert d'identifiant public pour la connexion employé ; il n'est pas un secret. */
async function ensureCompanyCode(ent) {
  if (ent.company_code) return ent.company_code;
  for (let i = 0; i < 20; i++) {
    const c = newCode();
    const r = await db.prepare('UPDATE entreprises SET company_code = ? WHERE id = ? AND company_code IS NULL AND NOT EXISTS (SELECT 1 FROM entreprises WHERE company_code = ?)').run(c, ent.id, c);
    if (r.changes) return c;
    const cur = await db.prepare('SELECT company_code FROM entreprises WHERE id = ?').get(ent.id);
    if (cur && cur.company_code) return cur.company_code;
  }
  throw new Error('code entreprise');
}
const regenerateCompanyCode = async (ent) => { await db.prepare('UPDATE entreprises SET company_code = NULL WHERE id = ?').run(ent.id); return ensureCompanyCode({ id: ent.id, company_code: null }); };

/**
 * Personne « sensible » : direction générale, directeur, poste de la finance ou de la trésorerie (responsable de l'espace Finances ou poste de ce département).
 * Elle doit activer la double authentification pour utiliser la connexion employé.
 */
async function isSensitive(entrepriseId, userId) {
  const p = await db.prepare('SELECT id FROM ent_people WHERE entreprise_id = ? AND user_id = ?').get(entrepriseId, userId);
  if (!p) return false;
  if (await db.prepare('SELECT 1 FROM ent_dg WHERE entreprise_id = ? AND person_id = ?').get(entrepriseId, p.id)) return true;
  const posts = await db.prepare(`SELECT po.kind, po.spaces, po.title FROM ent_assignments a JOIN ent_posts po ON po.id = a.post_id WHERE a.person_id = ?`).all(p.id);
  return posts.some((x) => x.kind === 'director' || (parseJSON(x.spaces, {}).finances === 'manage'));
}

/** L'enforcement : un compte qui utilise la connexion employé (secret enregistré), sensible et sans double authentification n'accède pas aux données de l'organisation. */
async function mustEnrollTwofa(org, user) {
  if (!org.entreprise_id || Number(user.totp_enabled)) return false;
  const cred = await db.prepare('SELECT 1 FROM ent_credentials c JOIN ent_people p ON p.id = c.person_id WHERE p.entreprise_id = ? AND p.user_id = ?').get(org.entreprise_id, user.id);
  if (!cred) return false; // comptes actuels (sans connexion employé) : jamais concernés
  const ent = await db.prepare('SELECT sensitive_2fa FROM entreprises WHERE id = ?').get(org.entreprise_id);
  return Boolean(ent && Number(ent.sensitive_2fa)) && await isSensitive(org.entreprise_id, user.id);
}

/** Organisation à ouvrir : la dernière utilisée (espace mémorisé), sinon la plus ancienne. Renvoie aussi le département reconnu. */
async function landingFor(entrepriseId, userId) {
  const orgs = await db.prepare(`SELECT o.id, o.name, m.role FROM orgs o JOIN org_members m ON m.org_id = o.id AND m.user_id = ? WHERE o.entreprise_id = ? ORDER BY o.id`).all(userId, entrepriseId);
  if (!orgs.length) return null;
  const pref = await db.prepare(`SELECT org_id FROM member_space_prefs WHERE user_id = ? AND org_id IN (${orgs.map(() => '?').join(',')}) ORDER BY updated_at DESC LIMIT 1`).get(userId, ...orgs.map((o) => o.id));
  const org = (pref && orgs.find((o) => Number(o.id) === Number(pref.org_id))) || orgs[0];
  const posts = await db.prepare(`SELECT po.title, d.name AS department FROM ent_assignments a JOIN ent_people p ON p.id = a.person_id JOIN ent_posts po ON po.id = a.post_id
    LEFT JOIN ent_departments d ON d.id = po.department_id WHERE a.org_id = ? AND p.user_id = ? ORDER BY a.id`).all(org.id, userId);
  return { orgId: Number(org.id), orgName: org.name, role: org.role, posts: posts.map((x) => ({ title: x.title, department: x.department || '' })) };
}

module.exports = { newCode, normCode, display, ensureCompanyCode, regenerateCompanyCode, isSensitive, mustEnrollTwofa, landingFor };
