'use strict';
// Rôles commerciaux : posés PAR-DESSUS les rôles de l'organisation (propriétaire, administrateur, responsable, membre).
// - Le propriétaire et les administrateurs ont tous les droits commerciaux et désignent le RESPONSABLE COMMERCIAL.
// - Le responsable commercial valide les remises, fixe objectifs, territoires, règles et commissions, et désigne assistants et commerciaux terrain.
// - L'assistant commercial PRÉPARE (fiches, devis en brouillon, relances, saisies d'activité) mais ne valide rien.
// - Le commercial terrain travaille sur SES comptes, prospects et opportunités (périmètre limité), saisit ses visites et appels.
// - Sans désignation : « lecture seule » pour un responsable de l'organisation, aucun accès pour un simple membre.
const { db, nowISO } = require('../../db');
const A = require('../access');
const { HttpError, oneLine } = require('../../util');

const CROLES = ['sales_manager', 'sales_assistant', 'sales_field'];
const LABEL = { sales_manager: 'Responsable commercial', sales_assistant: 'Assistant commercial', sales_field: 'Commercial terrain', viewer: 'Lecture seule', none: 'Aucun rôle commercial' };
const ALL = ['view', 'write', 'quote', 'activity', 'approve', 'targets', 'rules', 'pricing', 'commissions', 'merge', 'delete', 'export', 'coach', 'roles_light', 'roles'];
const PERMS = {
  sales_manager: ALL.filter((p) => p !== 'roles'),
  sales_assistant: ['view', 'write', 'quote', 'activity'],
  sales_field: ['view', 'write', 'quote', 'activity'],
  viewer: ['view'],
  none: [],
};

/** Rôle commercial effectif de la personne connectée (mis en cache sur la requête). */
async function load(req) {
  if (req.cp) return req.cp;
  const row = await db.prepare('SELECT * FROM cp_roles WHERE org_id = ? AND user_id = ?').get(req.org.id, req.user.id);
  const boss = A.can(req, 'admin');
  let crole = boss ? 'sales_manager' : row ? row.role : A.can(req, 'manager') ? 'viewer' : 'none';
  const perms = boss ? ALL : PERMS[crole] || [];
  let zones = []; try { zones = JSON.parse((row && row.zone_ids) || '[]'); } catch { zones = []; }
  req.cp = { crole, boss, perms, scopeOwn: crole === 'sales_field', teamId: row ? row.team_id : null, zones, designated: Boolean(row) };
  return req.cp;
}
const has = async (req, perm) => (await load(req)).perms.includes(perm);
const need = (perm) => async (req, res, next) => {
  const c = await load(req);
  if (!c.perms.includes(perm)) throw new HttpError(403, perm === 'view' ? "Vous n'avez pas de rôle commercial : demandez au responsable du compte de vous en désigner un." : 'Votre rôle commercial ne permet pas cette action.');
  next();
};
/** Filtre de périmètre pour un commercial terrain : seulement ses propres fiches. */
const own = async (req, col) => ((await load(req)).scopeOwn ? { sql: ` AND ${col} = ?`, args: [req.user.id] } : { sql: '', args: [] });
/** Un commercial terrain ne touche qu'à ses fiches (propriétaire de la fiche). */
async function mustOwn(req, row) {
  const c = await load(req);
  if (c.scopeOwn && Number(row.owner_id) !== req.user.id) throw new HttpError(403, 'Cette fiche est suivie par un autre commercial.');
}
async function audit(req, entity, id, action, detail) {
  const c = await load(req);
  await db.prepare('INSERT INTO cp_audit (org_id, user_id, crole, entity, entity_id, action, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(req.org.id, req.user ? req.user.id : null, c.crole, entity, id == null ? null : Number(id), action, oneLine(typeof detail === 'string' ? detail : JSON.stringify(detail || {}), 1500), nowISO());
}
module.exports = { CROLES, LABEL, PERMS, ALL, load, has, need, own, mustOwn, audit };
