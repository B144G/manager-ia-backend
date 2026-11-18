'use strict';
// RH Talents · socle : rôles RH désignés par le propriétaire, confidentialité, journal de traçabilité, outils de routes simples.
// Les rôles RH sont indépendants des rôles de l'organisation : un administrateur NON désigné n'a aucun accès aux évaluations ni aux rémunérations.
//   rh     : tout le module RH Talents (évaluations, talents, rémunérations, effectifs…)
//   recrut : recrutement (offres, candidats, entretiens)
//   talent : GPEC, objectifs, 360°, formation, talents, succession, engagement
//   remun  : rémunération et effectifs (coûts)
// Le propriétaire de l'organisation a tous les droits ; lui seul désigne les rôles.
const { db, nowISO } = require('../db');
const A = require('./access');
const W = require('./w3');
const { HttpError } = require('../util');

const ROLES = ['rh', 'recrut', 'talent', 'remun'];

async function rolesOf(req) {
  if (req._rhRoles) return req._rhRoles;
  const rows = await db.prepare('SELECT role FROM rh_roles WHERE org_id = ? AND user_id = ?').all(req.org.id, req.user.id);
  req._rhRoles = new Set(rows.map((r) => r.role));
  if (req.member.role === 'owner') ROLES.forEach((r) => req._rhRoles.add(r));
  return req._rhRoles;
}
/** La personne a-t-elle l'un de ces rôles RH (le rôle « rh » les couvre tous) ? */
async function has(req, ...roles) {
  const s = await rolesOf(req);
  return s.has('rh') || roles.some((r) => s.has(r));
}
/** Middleware : refuse sans l'un des rôles RH indiqués. Le message ne révèle rien du contenu. */
const need = (...roles) => async (req, res, next) => {
  if (!(await has(req, ...roles))) throw new HttpError(403, "Cet espace est réservé aux personnes désignées par le propriétaire de l'organisation.");
  next();
};

/** Fiche employé liée au compte de la personne connectée (ou null). */
async function meEmp(req) {
  if (req._rhMe !== undefined) return req._rhMe;
  req._rhMe = (await db.prepare("SELECT * FROM employees WHERE org_id = ? AND user_id = ? ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, id LIMIT 1").get(req.org.id, req.user.id)) || null;
  return req._rhMe;
}
/** Employé de l'organisation (404 sinon). La visibilité par antenne ne s'applique pas à l'intéressé lui-même ni aux personnes désignées. */
async function emp(req, id) {
  const e = await db.prepare('SELECT * FROM employees WHERE id = ? AND org_id = ?').get(A.id(id, 'Employé invalide.'), req.org.id);
  if (!e) throw new HttpError(404, 'Employé introuvable.');
  return e;
}
const isSelf = async (req, empId) => { const m = await meEmp(req); return !!m && Number(m.id) === Number(empId); };
/** Identifiants des employés qui ont la personne connectée pour responsable direct. */
async function reports(req) {
  const m = await meEmp(req);
  if (!m) return [];
  return (await db.prepare('SELECT employee_id FROM rh_emp_profile WHERE org_id = ? AND manager_id = ?').all(req.org.id, m.id)).map((r) => Number(r.employee_id));
}
const isManagerOf = async (req, empId) => (await reports(req)).includes(Number(empId));

/** Journal de traçabilité : toutes les écritures et les lectures de données confidentielles (entité préfixée « rh_ »). */
const audit = (req, entity, id, action, before, after) => W.audit(req, 'rh_' + entity, id, action, before, after);

const names = async (req) => new Map((await db.prepare('SELECT id, name FROM employees WHERE org_id = ?').all(req.org.id)).map((e) => [Number(e.id), e.name]));
const num = (v) => Number(v);
const today = () => nowISO().slice(0, 10);
const level = (v, msg = 'Niveau invalide (1 à 5).') => { const n = Number(v); if (!Number.isInteger(n) || n < 1 || n > 5) throw new HttpError(400, msg); return n; };
const must = (row, msg) => { if (!row) throw new HttpError(404, msg); return row; };
const fromOrg = async (req, table, id, msg) => must(await db.prepare(`SELECT * FROM ${table} WHERE id = ? AND org_id = ?`).get(A.id(id), req.org.id), msg);
const optRef = async (req, table, v, msg) => { if (v === undefined || v === null || v === '') return null; return Number((await fromOrg(req, table, v, msg)).id); };

/** Routes simples (liste, création, modification, suppression) avec droits RH. o = { path, table, entity, read, write, fields, order, decorate, validate, onCreate, onDelete, noCreated } */
function simple(router, o) {
  const cols = o.fields.map((f) => ({ ...f, c: f.c || W.snake(f.k) }));
  const row = (req, id) => fromOrg(req, o.table, id, o.notFound || 'Élément introuvable.');
  router.get(o.path, need(...o.read), async (req, res) => {
    let rows = await db.prepare(`SELECT * FROM ${o.table} WHERE org_id = ? ORDER BY ${o.order || 'id DESC'} LIMIT 1000`).all(req.org.id);
    if (o.decorate) rows = await o.decorate(req, rows);
    res.json({ items: rows.map((r) => (r._view ? r._view : W.camelRow(r))) });
  });
  router.post(o.path, need(...o.write), async (req, res) => {
    const b = req.body || {}; const vals = {};
    for (const f of cols) vals[f.c] = await W.parseField(req, f, b[f.k]);
    if (o.validate) await o.validate(req, vals, null);
    const names2 = ['org_id', ...Object.keys(vals), ...(o.noCreated ? [] : ['created_at'])];
    const id = Number((await db.prepare(`INSERT INTO ${o.table} (${names2.join(', ')}) VALUES (${names2.map(() => '?').join(', ')})`).run(req.org.id, ...Object.values(vals), ...(o.noCreated ? [] : [nowISO()]))).lastInsertRowid);
    await audit(req, o.entity, id, 'create', null, vals);
    if (o.onCreate) await o.onCreate(req, id, vals, b);
    res.status(201).json({ id });
  });
  router.put(`${o.path}/:id`, need(...o.write), async (req, res) => {
    const cur = await row(req, req.params.id); const b = req.body || {}; const vals = {};
    for (const f of cols) if (b[f.k] !== undefined) vals[f.c] = await W.parseField(req, f, b[f.k]);
    if (Object.keys(vals).length) {
      if (o.validate) await o.validate(req, vals, cur);
      await db.prepare(`UPDATE ${o.table} SET ${Object.keys(vals).map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...Object.values(vals), cur.id);
      await audit(req, o.entity, cur.id, 'update', Object.fromEntries(Object.keys(vals).map((c) => [c, cur[c]])), vals);
    }
    if (o.onUpdate) await o.onUpdate(req, cur, b);
    res.json({ ok: true });
  });
  router.delete(`${o.path}/:id`, need(...o.write), async (req, res) => {
    const cur = await row(req, req.params.id);
    if (o.onDelete) await o.onDelete(req, cur);
    await db.prepare(`DELETE FROM ${o.table} WHERE id = ?`).run(cur.id);
    await audit(req, o.entity, cur.id, 'delete', cur, null);
    res.json({ ok: true });
  });
}

module.exports = { ROLES, rolesOf, has, need, meEmp, emp, isSelf, reports, isManagerOf, audit, names, num, today, level, must, fromOrg, optRef, simple, A, W, db, nowISO, HttpError };
