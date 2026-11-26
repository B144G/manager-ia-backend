'use strict';
// Gestion des organisations : tableau de toutes les organisations de la personne (et de son entreprise), et état des lieux avant suppression.
//   GET /api/ws/organisations                       tableau (user)   ·   GET /api/ws/orgs/:orgId/deletion-impact   ce qui serait effacé (propriétaire)
// La suppression elle-même reste DELETE /api/ws/orgs/:orgId (index.js) : nom exact + mot de passe + règles de l'organisation principale.
const express = require('express');
const { db } = require('../db');
const A = require('./access');
const LK = require('./ent-links');
const { asyncHandler } = require('../util');

const router = express.Router();

const qs = (ids) => ids.map(() => '?').join(',');
/** Compte par organisation : { orgId: n }. Une table absente ou sans colonne org_id compte zéro (jamais d'erreur côté écran). */
async function countBy(table, ids, extra = '') {
  const out = {};
  if (!ids.length) return out;
  try {
    const rows = await db.prepare(`SELECT org_id, COUNT(*) AS c FROM ${table} WHERE org_id IN (${qs(ids)}) ${extra} GROUP BY org_id`).all(...ids);
    for (const r of rows) out[Number(r.org_id)] = Number(r.c);
  } catch { /* table propre à une version plus récente */ }
  return out;
}

/** Organisations visibles : celles dont la personne est membre + toutes celles de l'entreprise qu'elle gère (propriétaire de l'organisation principale ou direction générale). */
async function visibleOrgs(req) {
  const mine = await db.prepare('SELECT o.*, m.role AS my_role FROM orgs o JOIN org_members m ON m.org_id = o.id WHERE m.user_id = ? ORDER BY o.id').all(req.user.id);
  const byId = new Map(mine.map((o) => [Number(o.id), o]));
  const ents = new Map();
  for (const o of mine) {
    if (!o.entreprise_id || ents.has(Number(o.entreprise_id))) continue;
    const ent = await db.prepare('SELECT * FROM entreprises WHERE id = ?').get(o.entreprise_id);
    if (ent) ents.set(Number(ent.id), { ent, manage: await LK.canManage(req, ent), main: await LK.mainOrgOf(ent) });
  }
  for (const { ent, manage } of ents.values()) {
    if (!manage) continue;
    for (const o of await db.prepare('SELECT * FROM orgs WHERE entreprise_id = ? ORDER BY id').all(ent.id)) if (!byId.has(Number(o.id))) byId.set(Number(o.id), { ...o, my_role: null });
  }
  return { orgs: [...byId.values()].sort((a, b) => Number(a.id) - Number(b.id)), ents };
}

router.get('/', asyncHandler(async (req, res) => {
  const { orgs, ents } = await visibleOrgs(req);
  const ids = orgs.map((o) => Number(o.id));
  const [members, branches] = await Promise.all([countBy('org_members', ids), countBy('branches', ids)]);
  const cp = require('../services/custom-plan');
  const rows = [];
  for (const o of orgs) {
    const id = Number(o.id); const e = o.entreprise_id ? ents.get(Number(o.entreprise_id)) : null;
    const plan = await A.ownerPlan(o); const lim = A.limitsFor(plan);
    const used = { members: members[id] || 0, branches: branches[id] || 0 };
    const full = used.members >= lim.members || used.branches >= lim.branches;
    const mine = o.my_role !== null && o.my_role !== undefined;
    rows.push({
      id, name: o.name, sector: o.sector || '', currency: o.currency, createdAt: o.created_at,
      company: e ? { id: Number(e.ent.id), name: e.ent.name } : null,
      type: e && e.main && Number(e.main.id) !== id ? 'linked' : 'main', // une organisation seule est « principale » de sa propre entreprise
      myRole: mine ? o.my_role : null, // null : visible par la direction de l'entreprise, sans en être membre
      members: used.members, membersMax: lim.members, branches: used.branches, branchesMax: lim.branches,
      plan, planLabel: cp.label(plan), state: full ? 'limit' : 'active',
      canOpen: mine, canTransfer: mine && o.my_role === 'owner', canDelete: mine && o.my_role === 'owner',
    });
  }
  res.json({ orgs: rows, companies: [...ents.values()].map((x) => ({ id: Number(x.ent.id), name: x.ent.name, manage: x.manage })) });
}));

/** Ce qui sera effacé avec l'organisation (nombres réels) et les obstacles éventuels. Réservé au propriétaire. */
async function deletionImpact(req) {
  const id = Number(req.org.id); const ids = [id];
  const n = async (table, extra) => (await countBy(table, ids, extra))[id] || 0;
  const [members, branches, customers, products, entries, files, projects, tasks, tickets, employees, invoices] = await Promise.all([
    n('org_members'), n('branches'), n('customers'), n('stock_items'), n('acc_entries'), n('org_files'), n('projects'), n('tasks'), n('tickets'), n('employees'), n('documents'),
  ]);
  let msgs = 0; try { msgs = Number((await db.prepare('SELECT COUNT(*) c FROM chat_messages WHERE chat_id IN (SELECT id FROM chats WHERE org_id = ?)').get(id)).c); } catch { /* */ }
  let wa = 0; try { wa = (await db.prepare('SELECT COUNT(*) c FROM wa_qr_sessions WHERE org_id = ?').get(id)).c; } catch { /* */ }
  let others = []; let isMain = false; let lastOfCompany = true;
  if (req.org.entreprise_id) {
    const ent = await db.prepare('SELECT * FROM entreprises WHERE id = ?').get(req.org.entreprise_id);
    const main = ent ? await LK.mainOrgOf(ent) : null;
    isMain = Boolean(main) && Number(main.id) === id;
    others = await db.prepare('SELECT id, name FROM orgs WHERE entreprise_id = ? AND id <> ? ORDER BY id').all(req.org.entreprise_id, id);
    lastOfCompany = others.length === 0;
  }
  const blockedByLinked = isMain && others.length > 0;
  return {
    org: { id, name: req.org.name },
    counts: { members: Math.max(0, members - 1), branches, customers, products, entries, files, projects, tasks, tickets, employees, documents: invoices, whatsapp: Number(wa) },
    peopleLosingAccess: Math.max(0, members - 1),
    isMain, lastOfCompany,
    linked: others.map((o) => ({ id: Number(o.id), name: o.name })),
    blocked: blockedByLinked ? 'linked_orgs' : null,
  };
}

module.exports = { router, deletionImpact, visibleOrgs };
