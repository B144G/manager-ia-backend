'use strict';
// Compte d'entreprise : rattachement des organisations à une entreprise (création paresseuse) et droits issus de la structure.
// Rien ici ne donne de droit à quelqu'un qui n'est affecté à aucun poste (structureLevels renvoie null : l'ancien comportement s'applique tel quel).
const { db, nowISO } = require('../db');
const { parseJSON } = require('../util');

const LV = { none: 0, view: 1, write: 2, manage: 3 };
const SPACE_IDS = ['direction', 'commercial', 'finances', 'stock', 'rh', 'operations', 'projets', 'gestion', 'compte', 'dir_general', 'dir_technique', 'dir_commercial', 'dir_finances', 'dir_rh', 'dir_production', 'dir_logistique', 'dir_stock', 'dir_marketing', 'dir_it', 'dir_securite'];

/** Interrupteur général : ENTREPRISE_RIGHTS=off|0|false|non coupe le lien structure → droits pour toutes les entreprises (la structure reste visible). */
const globalOff = () => /^(off|0|false|no|non|disabled|desactive|désactivé)$/i.test(String(process.env.ENTREPRISE_RIGHTS || '').trim());

/** Réglages de la configuration d'une organisation (avancement, lien avec les droits). Sans ligne : lien actif, rien d'avancé. */
async function setupOf(orgId) {
  const r = await db.prepare('SELECT * FROM ent_setup WHERE org_id = ?').get(orgId);
  return { steps: r ? parseJSON(r.steps, {}) : {}, template: r ? r.template : '', rightsLink: r ? Boolean(Number(r.rights_link)) : true, completedAt: r ? r.completed_at : null, explicit: Boolean(r) };
}

/** Entreprise d'une organisation ; la crée si l'organisation n'en a pas encore (organisation créée par un autre chemin que POST /orgs). Le propriétaire devient directeur général. */
async function ensureEntreprise(org) {
  if (org.entreprise_id) {
    const e = await db.prepare('SELECT * FROM entreprises WHERE id = ?').get(org.entreprise_id);
    if (e) return e;
  }
  const now = nowISO();
  const id = await db.transaction(async () => {
    const fresh = await db.prepare('SELECT entreprise_id FROM orgs WHERE id = ?').get(org.id);
    if (fresh && fresh.entreprise_id) return Number(fresh.entreprise_id);
    const eid = await createFor(org, now);
    return eid;
  })();
  org.entreprise_id = id;
  return db.prepare('SELECT * FROM entreprises WHERE id = ?').get(id);
}

/** À appeler dans une transaction : crée l'entreprise de l'organisation, la personne du propriétaire et la direction générale. */
async function createFor(org, now = nowISO()) {
  const eid = (await db.prepare('INSERT INTO entreprises (name, sector, currency, owner_user_id, legacy_org_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(org.name, '', org.currency || 'FCFA', org.owner_id, org.id, now, now)).lastInsertRowid;
  await db.prepare('UPDATE orgs SET entreprise_id = ? WHERE id = ?').run(eid, org.id);
  const members = await db.prepare('SELECT m.user_id, m.created_at, u.name, u.contact FROM org_members m JOIN users u ON u.id = m.user_id WHERE m.org_id = ?').all(org.id);
  for (const m of members) {
    const pid = (await db.prepare('INSERT INTO ent_people (entreprise_id, user_id, full_name, email, status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(eid, m.user_id, m.name, String(m.contact || '').includes('@') ? m.contact : '', 'active', m.created_at || now)).lastInsertRowid;
    if (Number(m.user_id) === Number(org.owner_id)) await db.prepare('INSERT INTO ent_dg (entreprise_id, person_id, created_at) VALUES (?, ?, ?)').run(eid, pid, now);
  }
  return Number(eid);
}

/** Personne (identité individuelle) d'une entreprise pour un compte ; la crée si absente (arrivée dans l'équipe par un autre chemin que l'assistant). */
async function personForUser(entrepriseId, user, now = nowISO()) {
  const p = await db.prepare('SELECT * FROM ent_people WHERE entreprise_id = ? AND user_id = ?').get(entrepriseId, user.id);
  if (p) return p;
  const email = String(user.contact || '').includes('@') ? user.contact : '';
  const id = (await db.prepare('INSERT INTO ent_people (entreprise_id, user_id, full_name, email, status, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING').run(entrepriseId, user.id, user.name, email, 'active', now)).lastInsertRowid;
  return db.prepare('SELECT * FROM ent_people WHERE entreprise_id = ? AND user_id = ?').get(entrepriseId, user.id) || { id };
}

/** Une personne invitée par un code personnel vient de rejoindre : on relie son compte à sa fiche (sa place dans la structure suit). Appelé par POST /orgs/join. */
async function onJoin(org, user, code) {
  try {
    if (!org.entreprise_id) await ensureEntreprise(org);
    const pending = code ? await db.prepare('SELECT * FROM ent_people WHERE entreprise_id = ? AND invite_code = ? AND user_id IS NULL').get(org.entreprise_id, code) : null;
    const mine = await db.prepare('SELECT * FROM ent_people WHERE entreprise_id = ? AND user_id = ?').get(org.entreprise_id, user.id);
    if (pending && !mine) {
      await db.prepare("UPDATE ent_people SET user_id = ?, status = 'active', invite_code = NULL WHERE id = ?").run(user.id, pending.id);
    } else {
      if (pending) await db.prepare("UPDATE ent_people SET status = 'revoked', invite_code = NULL WHERE id = ?").run(pending.id);
      await personForUser(org.entreprise_id, user);
    }
  } catch { /* le rattachement ne doit jamais empêcher de rejoindre une équipe */ }
}

/**
 * Niveaux d'espaces donnés par la structure (affectations aux postes, direction générale) à une personne DE CETTE organisation.
 * Renvoie null quand la personne n'est affectée à rien (ou que le lien est coupé) : l'ancien comportement s'applique alors à l'identique.
 * Un poste ou un département désactivé ne donne rien. Plusieurs postes : le niveau le plus haut par espace.
 */
async function structureLevels(orgId, userId) {
  if (globalOff()) return null;
  const st = await db.prepare('SELECT rights_link FROM ent_setup WHERE org_id = ?').get(orgId);
  if (st && !Number(st.rights_link)) return null;
  const posts = await db.prepare(`SELECT p.spaces, p.kind, p.direction_id, p.tkey FROM ent_assignments a
    JOIN ent_people pe ON pe.id = a.person_id JOIN ent_posts p ON p.id = a.post_id
    LEFT JOIN ent_departments d ON d.id = p.department_id
    WHERE a.org_id = ? AND pe.user_id = ? AND p.active = 1 AND (p.department_id IS NULL OR d.active = 1)`).all(orgId, userId);
  const dg = await db.prepare(`SELECT 1 AS x FROM ent_dg g JOIN ent_people pe ON pe.id = g.person_id JOIN orgs o ON o.entreprise_id = g.entreprise_id
    WHERE o.id = ? AND pe.user_id = ?`).get(orgId, userId);
  if (!posts.length && !dg) return null;
  const D = require('./ent-direction'); const dirOn = await D.enabled(orgId);
  const out = {};
  const up = (sp, lv) => { if (SPACE_IDS.includes(sp) && LV[lv] > LV[out[sp] || 'none']) out[sp] = lv; };
  if (dg && dirOn) up('dir_general', 'manage'); // cockpit de la direction générale
  if (dg) { up('direction', 'manage'); for (const sp of SPACE_IDS) if (sp !== 'direction' && sp !== 'compte' && sp !== 'projets' && (!sp.startsWith('dir_') || (dirOn && sp !== 'dir_general'))) up(sp, 'view'); }
  for (const p of posts) {
    const own = p.kind === 'director' ? await D.dirSpaceOfPost(p) : null;
    for (const [sp, lv] of Object.entries(parseJSON(p.spaces, {}))) {
      if (D.isDir(sp)) { // espace de direction : seulement un poste de DIRECTEUR, responsable de SON espace ; ailleurs en consultation au plus ; jamais pour le personnel
        if (!dirOn || p.kind !== 'director') continue;
        up(sp, sp === own ? lv : (lv === 'manage' || lv === 'write' ? 'view' : lv));
      } else up(sp, lv);
    }
  }
  return out;
}

module.exports = { ensureEntreprise, createFor, personForUser, onJoin, structureLevels, setupOf, globalOff, SPACE_IDS, LV };
