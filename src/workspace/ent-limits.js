'use strict';
// Compte d'entreprise : limites de l'abonnement de l'entreprise (étapes 4, 5 et 6). L'abonnement est celui du titulaire de l'entreprise (A.ownerPlan : entreprise principale pour une organisation liée).
// Trois paliers déduits des limites existantes de l'offre (nombre d'organisations) : jamais de limite plus basse que celles déjà appliquées ailleurs.
const { db } = require('../db');
const A = require('./access');

const TIERS = {
  free: { partners: 2, partnersPerType: 1, sharedSpaces: 3, objectsPerSpace: 5, departments: 12, posts: 60, people: 10, directions: 12, profiles: 5, fileMb: 3 },
  pro: { partners: 10, partnersPerType: 5, sharedSpaces: 30, objectsPerSpace: 50, departments: 40, posts: 200, people: 60, directions: 20, profiles: 25, fileMb: 10 },
  unlimited: { partners: 999, partnersPerType: 999, sharedSpaces: 999, objectsPerSpace: 999, departments: 80, posts: 400, people: 600, directions: 30, profiles: 99, fileMb: 15 },
};
const tierOf = (plan) => { const o = A.limitsFor(plan).orgs; return o >= 999 ? 'unlimited' : o >= 3 ? 'pro' : 'free'; };
async function forOrg(org) { const plan = await A.ownerPlan(org); const tier = tierOf(plan); return { plan, tier, ...TIERS[tier], ...A.limitsFor(plan) }; }

/** Utilisation actuelle de l'entreprise de l'organisation (pour les écrans d'usage et les refus clairs). */
async function usageOf(org) {
  const lim = await forOrg(org);
  const eid = org.entreprise_id;
  const n = async (sql, ...a) => Number((await db.prepare(sql).get(...a)).c) || 0;
  const orgIds = eid ? (await db.prepare('SELECT id FROM orgs WHERE entreprise_id = ?').all(eid)).map((o) => Number(o.id)) : [Number(org.id)];
  const inOrgs = `IN (${orgIds.join(',')})`;
  return {
    plan: lim.plan, tier: lim.tier,
    items: [
      { key: 'orgs', used: orgIds.length, max: lim.orgs },
      { key: 'members', used: await n(`SELECT COUNT(*) c FROM org_members WHERE org_id ${inOrgs}`), max: lim.members * orgIds.length, perOrg: lim.members },
      { key: 'branches', used: await n(`SELECT COUNT(*) c FROM branches WHERE org_id ${inOrgs}`), max: lim.branches * orgIds.length, perOrg: lim.branches },
      { key: 'ai', used: await require('./access').aiUsed(org), max: lim.aiMonth, scope: 'org' },
      { key: 'directions', used: await n('SELECT COUNT(*) c FROM ent_directions WHERE org_id = ?', org.id), max: lim.directions, scope: 'org' },
      { key: 'departments', used: await n('SELECT COUNT(*) c FROM ent_departments WHERE org_id = ?', org.id), max: lim.departments, scope: 'org' },
      { key: 'posts', used: await n('SELECT COUNT(*) c FROM ent_posts WHERE org_id = ?', org.id), max: lim.posts, scope: 'org' },
      { key: 'people', used: eid ? await n("SELECT COUNT(*) c FROM ent_people WHERE entreprise_id = ? AND status <> 'revoked'", eid) : 0, max: lim.people },
      { key: 'partners', used: await n("SELECT COUNT(*) c FROM ent_partnerships WHERE (org_a = ? OR org_b = ?) AND status IN ('invited', 'awaiting', 'active')", org.id, org.id), max: lim.partners, scope: 'org' },
      { key: 'sharedSpaces', used: await n("SELECT COUNT(*) c FROM shared_spaces WHERE owner_org_id = ? AND status = 'active'", org.id), max: lim.sharedSpaces, scope: 'org' },
    ],
  };
}

module.exports = { TIERS, tierOf, forOrg, usageOf };
