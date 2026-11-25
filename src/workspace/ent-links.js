'use strict';
// Compte d'entreprise, étape 4 : organisations liées (filiales, sites) par lien d'association.
// Le DG (ou le propriétaire de l'organisation principale) crée un lien à usage unique ; la personne qui crée l'organisation colle le code, l'organisation est alors rattachée
// à la MÊME entreprise (direction générale commune, abonnement de l'entreprise principale), avec copie de la structure. Les affectations restent propres à chaque organisation.
const crypto = require('crypto');
const { db, nowISO } = require('../db');
const A = require('./access');
const { HttpError } = require('../util');

const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const newToken = () => 'ASSO-' + crypto.randomBytes(15).toString('hex').toUpperCase().match(/.{1,6}/g).join('-');
const normToken = (v) => String(v || '').trim().toUpperCase().replace(/\s+/g, '').slice(0, 80);

/** Organisation principale de l'entreprise (celle qui l'a créée). */
async function mainOrgOf(ent) {
  if (ent.legacy_org_id) { const o = await db.prepare('SELECT * FROM orgs WHERE id = ?').get(ent.legacy_org_id); if (o) return o; }
  return db.prepare('SELECT * FROM orgs WHERE entreprise_id = ? ORDER BY id LIMIT 1').get(ent.id);
}
/** Qui peut créer des liens et gérer l'entreprise : le propriétaire de l'organisation principale, ou une personne de la direction générale qui est administratrice de cette organisation. */
async function canManage(req, ent) {
  const main = await mainOrgOf(ent);
  if (!main) return false;
  if (Number(main.owner_id) === Number(req.user.id)) return true;
  const dg = await db.prepare('SELECT 1 FROM ent_dg g JOIN ent_people p ON p.id = g.person_id WHERE g.entreprise_id = ? AND p.user_id = ?').get(ent.id, req.user.id);
  if (!dg) return false;
  const m = await db.prepare('SELECT role FROM org_members WHERE org_id = ? AND user_id = ?').get(main.id, req.user.id);
  return Boolean(m) && A.RANK[m.role] >= A.RANK.admin;
}
const log = (entId, orgId, linkId, userId, action, detail = '') => db.prepare('INSERT INTO ent_link_log (entreprise_id, org_id, link_id, user_id, action, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(entId, orgId || null, linkId || null, userId || null, action, String(detail).slice(0, 300), nowISO());

async function createLink(req, ent, { label, days, copyStructure }) {
  const token = newToken();
  const d = Math.min(Math.max(Number(days) || 7, 1), 30);
  const id = Number((await db.prepare('INSERT INTO ent_links (entreprise_id, token_hash, hint, label, copy_structure, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(ent.id, sha(token), token.slice(-4), A.text(label, 80), copyStructure === false ? 0 : 1, req.user.id, nowISO(), new Date(Date.now() + d * 86400000).toISOString())).lastInsertRowid);
  await log(ent.id, null, id, req.user.id, 'link_created', label || '');
  return { id, token, expiresAt: new Date(Date.now() + d * 86400000).toISOString() };
}

/** Lien utilisable (existe, non utilisé, non révoqué, non expiré) ; sinon un message unique qui ne révèle rien. */
async function usableLink(code) {
  const t = normToken(code);
  const bad = new HttpError(400, "Ce lien d'association est invalide, expiré ou déjà utilisé. Demandez-en un nouveau à la direction générale.");
  if (t.length < 10) throw bad;
  const l = await db.prepare('SELECT * FROM ent_links WHERE token_hash = ?').get(sha(t));
  if (!l || l.used_at || l.revoked_at || Date.parse(l.expires_at) < Date.now()) throw bad;
  const ent = await db.prepare('SELECT * FROM entreprises WHERE id = ?').get(l.entreprise_id);
  if (!ent) throw bad;
  return { link: l, ent };
}

/** Limite d'organisations de l'entreprise : celle de l'abonnement du titulaire (l'entreprise principale). */
async function assertOrgRoom(ent) {
  const owner = await require('../db').getUserFresh(ent.owner_user_id);
  const lim = A.limitsFor((owner || {}).plan || 'Gratuit').orgs;
  const n = Number((await db.prepare('SELECT COUNT(*) c FROM orgs WHERE entreprise_id = ?').get(ent.id)).c);
  if (n >= lim) throw new HttpError(403, `L'abonnement de l'entreprise principale permet ${lim} organisation(s) : la limite est atteinte. La direction générale peut passer à une offre supérieure.`);
}

/** Copie la structure (directions, départements, postes, profils) de l'organisation principale vers la nouvelle : sans personnes, sans affectations. */
async function copyStructure(srcOrgId, dstOrgId) {
  const now = nowISO();
  const dmap = new Map(); const pmap = new Map();
  for (const d of await db.prepare('SELECT * FROM ent_directions WHERE org_id = ? ORDER BY sort, id').all(srcOrgId))
    dmap.set(Number(d.id), Number((await db.prepare('INSERT INTO ent_directions (org_id, name, tkey, sort, active, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(dstOrgId, d.name, d.tkey, d.sort, d.active, now)).lastInsertRowid));
  for (const d of await db.prepare('SELECT * FROM ent_departments WHERE org_id = ? ORDER BY sort, id').all(srcOrgId))
    pmap.set(Number(d.id), Number((await db.prepare('INSERT INTO ent_departments (org_id, direction_id, name, tkey, sort, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(dstOrgId, d.direction_id ? dmap.get(Number(d.direction_id)) || null : null, d.name, d.tkey, d.sort, d.active, now)).lastInsertRowid));
  let posts = 0;
  for (const p of await db.prepare('SELECT * FROM ent_posts WHERE org_id = ? ORDER BY sort, id').all(srcOrgId)) {
    await db.prepare('INSERT INTO ent_posts (org_id, direction_id, department_id, title, kind, spaces, headcount, tkey, sort, active, profile_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(dstOrgId, p.direction_id ? dmap.get(Number(p.direction_id)) || null : null, p.department_id ? pmap.get(Number(p.department_id)) || null : null, p.title, p.kind, p.spaces, p.headcount, p.tkey, p.sort, p.active, p.profile_key, now);
    posts++;
  }
  for (const pr of await db.prepare('SELECT * FROM ent_profiles WHERE org_id = ?').all(srcOrgId))
    await db.prepare('INSERT INTO ent_profiles (org_id, key, config, updated_by, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING').run(dstOrgId, pr.key, pr.config, pr.updated_by, now);
  const st = await db.prepare('SELECT template FROM ent_setup WHERE org_id = ?').get(srcOrgId);
  if (st) await db.prepare("INSERT INTO ent_setup (org_id, steps, template, updated_at) VALUES (?, '{}', ?, ?) ON CONFLICT DO NOTHING").run(dstOrgId, st.template, now);
  return { directions: dmap.size, departments: pmap.size, posts };
}

/**
 * Crée l'organisation liée (dans la transaction de POST /orgs). Le créateur en est le propriétaire ; les directeurs généraux de l'entreprise y sont ajoutés comme administrateurs
 * (direction générale commune) ; l'abonnement de l'entreprise principale s'applique.
 */
async function attach(orgId, org, { link, ent }, creatorId) {
  await db.prepare('UPDATE orgs SET entreprise_id = ?, linked_via = ? WHERE id = ?').run(ent.id, link.id, orgId);
  const U = require('../db');
  const creator = await db.prepare('SELECT id, name, contact FROM users WHERE id = ?').get(creatorId);
  await require('./ent-lib').personForUser(ent.id, creator);
  const now = nowISO();
  const dgs = await db.prepare('SELECT p.user_id FROM ent_dg g JOIN ent_people p ON p.id = g.person_id WHERE g.entreprise_id = ? AND p.user_id IS NOT NULL').all(ent.id);
  let added = 0;
  for (const d of dgs) {
    if (Number(d.user_id) === Number(creatorId)) continue;
    const r = await db.prepare("INSERT INTO org_members (org_id, user_id, role, title, created_at) VALUES (?, ?, 'admin', 'Directeur général', ?) ON CONFLICT DO NOTHING").run(orgId, d.user_id, now);
    added += r.changes ? 1 : 0;
  }
  const copied = link.copy_structure ? await copyStructure((await mainOrgOf(ent)).id, orgId) : null;
  const used = await db.prepare('UPDATE ent_links SET used_at = ?, used_org_id = ? WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL').run(now, orgId, link.id);
  if (!used.changes) throw new HttpError(400, "Ce lien d'association vient d'être utilisé ou révoqué. Demandez-en un nouveau.");
  await log(ent.id, orgId, link.id, creatorId, 'org_linked', `${org} · DG ajoutés : ${added}`);
  void U;
  return { copied, dgAdded: added };
}

module.exports = { mainOrgOf, canManage, createLink, usableLink, assertOrgRoom, attach, log, normToken };
