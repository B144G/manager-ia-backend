'use strict';
// Compte d'entreprise (étape 1) : entreprise, direction générale, directions du pilotage, départements, postes, personnes et affectations.
// Routes : /api/ws/orgs/:orgId/entreprise/…  Droits TOUJOURS vérifiés ici (lecture : tout membre ; écriture : administrateur ; direction générale et lien avec les droits : propriétaire).
// Chaque requête est filtrée par organisation (org_id) et par entreprise ; un identifiant d'une autre organisation répond « introuvable ».
const crypto = require('crypto');
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const W = require('./w3');
const E = require('./ent-lib');
const T = require('./ent-templates');
const AL = require('./ent-auth-lib');
const PR = require('./ent-profiles');
const LK = require('./ent-links');
/** Réglages qui engagent TOUTE l'entreprise (informations, direction générale, code, double authentification) : propriétaire de l'organisation principale ou DG administrateur. Les organisations liées les voient sans les modifier. */
const entWide = async (req, res, next) => { if (!await LK.canManage(req, req.ent)) throw new HttpError(403, "Réservé à la direction générale et à l'organisation principale de l'entreprise."); next(); };
const limits = require('../middleware/limits');
const { HttpError, parseJSON } = require('../util');

const router = express.Router({ mergeParams: true });
const SIZES = ['1-5', '6-20', '21-50', '51-200', '200+'];
const KINDS = ['director', 'head', 'staff'];
const LEVELS = ['view', 'write', 'manage'];
const MAX = { directions: 30, departments: 80, posts: 400, people: 600 };
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// Limitation de débit des écritures (anti-abus) : la lecture n'est pas limitée ici.
const writeLimit = limits.make(10 * 60 * 1000, Math.max(parseInt(process.env.ENTREPRISE_WRITE_RATE, 10) || 400, 20), 'Trop de modifications à la suite. Patientez quelques minutes puis réessayez.');
router.use((req, res, next) => (req.method === 'GET' || req.method === 'HEAD' ? next() : writeLimit(req, res, next)));

// L'entreprise de l'organisation (créée au besoin) et la mise à niveau des fiches des membres déjà présents.
router.use(async (req, res, next) => {
  req.ent = await E.ensureEntreprise(req.org);
  const missing = await db.prepare(`SELECT m.user_id, u.name, u.contact FROM org_members m JOIN users u ON u.id = m.user_id
    WHERE m.org_id = ? AND NOT EXISTS (SELECT 1 FROM ent_people p WHERE p.entreprise_id = ? AND p.user_id = m.user_id)`).all(req.org.id, req.ent.id);
  for (const m of missing) await E.personForUser(req.ent.id, { id: m.user_id, name: m.name, contact: m.contact });
  next();
});

// ---------- Aides ----------
const own = (req, v, what) => { const n = A.id(v, 'Identifiant invalide.'); return n; };
const pickName = (v, msg) => A.text(v, 120, { required: true, msg });
const cleanSpaces = (req, v) => {
  if (v === undefined) return undefined;
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new HttpError(400, "Accès non valides : indiquez un niveau par espace.");
  const out = {};
  for (const [k, lv] of Object.entries(v)) {
    if (!E.SPACE_IDS.includes(k) || !LEVELS.includes(lv)) throw new HttpError(400, 'Espace ou niveau inconnu.');
    if (k === 'compte' && lv === 'manage' && !A.can(req, 'owner')) throw new HttpError(403, "Seul le propriétaire peut donner la responsabilité de l'espace Administration du compte.");
    out[k] = lv;
  }
  return out;
};
const audit = (req, entity, id, action, before, after) => W.audit(req, entity, id, action, before, after);
const count = async (sql, ...a) => Number((await db.prepare(sql).get(...a)).c) || 0;
const flag = (v, cur) => (v === undefined ? cur : (v ? 1 : 0));

async function loadDir(req, id) { const r = await db.prepare('SELECT * FROM ent_directions WHERE id = ? AND org_id = ?').get(own(req, id), req.org.id); if (!r) throw new HttpError(404, 'Direction introuvable.'); return r; }
async function loadDept(req, id) { const r = await db.prepare('SELECT * FROM ent_departments WHERE id = ? AND org_id = ?').get(own(req, id), req.org.id); if (!r) throw new HttpError(404, 'Département introuvable.'); return r; }
async function loadPost(req, id) { const r = await db.prepare('SELECT * FROM ent_posts WHERE id = ? AND org_id = ?').get(own(req, id), req.org.id); if (!r) throw new HttpError(404, 'Poste introuvable.'); return r; }
async function dirOrNull(req, v) { if (v === undefined || v === null || v === '') return null; return (await loadDir(req, v)).id; }
async function deptOrNull(req, v) { if (v === undefined || v === null || v === '') return null; return (await loadDept(req, v)).id; }

/** Personnes visibles dans cette organisation : membres de l'organisation et personnes invitées par un code de cette organisation. */
async function peopleRows(req) {
  return db.prepare(`SELECT p.*, m.role, m.title AS member_title FROM ent_people p LEFT JOIN org_members m ON m.user_id = p.user_id AND m.org_id = ?
    WHERE p.entreprise_id = ? AND p.status <> 'revoked' AND (m.id IS NOT NULL OR (p.user_id IS NULL AND p.invite_org_id = ?)) ORDER BY p.id`).all(req.org.id, req.ent.id, req.org.id);
}
function personView(req, p, codes) {
  const rich = A.can(req, 'manager');
  const pending = !p.user_id;
  return {
    id: Number(p.id), name: p.full_name, status: pending ? 'invited' : 'active', userId: p.user_id ? Number(p.user_id) : null, role: p.role || null, memberTitle: p.member_title || '',
    email: rich ? p.email : undefined, phone: rich ? p.phone : undefined,
    inviteCode: pending && A.can(req, 'admin') ? (codes[p.invite_code] || null) : undefined, // un code personnel est un secret : réservé aux administrateurs
  };
}
async function inviteCodes(req) {
  const rows = await db.prepare('SELECT code FROM invites WHERE org_id = ? AND expires_at > ?').all(req.org.id, nowISO());
  return Object.fromEntries(rows.map((r) => [r.code, r.code]));
}

const entView = (req, e) => {
  const rich = A.can(req, 'manager');
  const sec = T.SECTORS.find((s) => s.id === e.sector);
  return { id: Number(e.id), name: e.name, sector: e.sector, sectorLabel: sec ? sec.title : '', country: e.country, currency: e.currency, address: e.address, city: e.city, size: e.size,
    phone: rich ? e.phone : undefined, email: rich ? e.email : undefined, website: e.website, legalForm: rich ? e.legal_form : undefined, rccm: rich ? e.rccm : undefined, niu: rich ? e.niu : undefined, vatNumber: rich ? e.vat_number : undefined };
};

// ---------- Vue d'ensemble ----------
router.get('/', async (req, res) => {
  const o = req.org.id;
  const setup = await E.setupOf(o);
  const posts = await db.prepare('SELECT p.id, p.headcount, (SELECT COUNT(*) FROM ent_assignments a WHERE a.post_id = p.id) AS n FROM ent_posts p LEFT JOIN ent_departments d ON d.id = p.department_id WHERE p.org_id = ? AND p.active = 1 AND (p.department_id IS NULL OR d.active = 1)').all(o);
  const vacancies = posts.reduce((s, p) => s + Math.max(Number(p.headcount) - Number(p.n), 0), 0);
  res.json({
    entreprise: entView(req, req.ent),
    setup: { steps: setup.steps, template: setup.template, completedAt: setup.completedAt, rightsLink: setup.rightsLink, globalOff: E.globalOff() },
    counts: { directions: await count('SELECT COUNT(*) c FROM ent_directions WHERE org_id = ? AND active = 1', o), departments: await count('SELECT COUNT(*) c FROM ent_departments WHERE org_id = ? AND active = 1', o), posts: posts.length, people: (await peopleRows(req)).length, vacancies },
    sectors: T.SECTORS, sizes: SIZES, spaces: E.SPACE_IDS,
    can: { edit: A.can(req, 'admin'), owner: A.can(req, 'owner') },
    companyCode: A.can(req, 'admin') ? AL.display(await AL.ensureCompanyCode(req.ent)) : undefined, // identifiant public de connexion employé (étape 2), pas un secret
    sensitive2fa: Boolean(Number(req.ent.sensitive_2fa)),
  });
});

router.get('/templates', async (req, res) => {
  res.json({ sectors: T.SECTORS.map((s) => {
    const p = T.planFor(s.id);
    return { ...s, directions: p.directions.filter((d) => d.active).map((d) => d.name), departments: p.departments.filter((d) => d.active).map((d) => ({ name: d.name, posts: d.posts.map((x) => x.title) })), optional: p.departments.filter((d) => !d.active).map((d) => d.name) };
  }) });
});

// ---------- Informations propres de l'entreprise ----------
router.put('/info', A.need('admin'), entWide, async (req, res) => {
  const b = req.body || {}; const e = req.ent;
  const sector = b.sector === undefined ? e.sector : (b.sector === '' ? '' : A.oneOf(b.sector, T.SECTOR_IDS, undefined, 'Secteur inconnu.'));
  const size = b.size === undefined ? e.size : (b.size === '' ? '' : A.oneOf(b.size, SIZES, undefined, 'Taille inconnue.'));
  const email = b.email === undefined ? e.email : A.text(b.email, 120);
  if (email && !EMAIL.test(email)) throw new HttpError(400, 'Adresse e-mail invalide.');
  const v = {
    name: b.name === undefined ? e.name : A.text(b.name, 120, { required: true, msg: 'Indiquez la raison sociale.' }),
    country: b.country === undefined ? e.country : A.text(b.country, 80), currency: b.currency === undefined ? e.currency : (A.text(b.currency, 10) || 'FCFA'),
    address: b.address === undefined ? e.address : A.text(b.address, 200), city: b.city === undefined ? e.city : A.text(b.city, 80),
    phone: b.phone === undefined ? e.phone : A.text(b.phone, 40), website: b.website === undefined ? e.website : A.text(b.website, 160),
    legal_form: b.legalForm === undefined ? e.legal_form : A.text(b.legalForm, 60),
    // Identifiants légaux : facultatifs, saisis par l'entreprise elle-même, jamais déduits ni inventés.
    rccm: b.rccm === undefined ? e.rccm : A.text(b.rccm, 60), niu: b.niu === undefined ? e.niu : A.text(b.niu, 60), vat_number: b.vatNumber === undefined ? e.vat_number : A.text(b.vatNumber, 60),
  };
  await db.transaction(async () => {
    await db.prepare(`UPDATE entreprises SET name = ?, sector = ?, country = ?, currency = ?, address = ?, city = ?, size = ?, phone = ?, email = ?, website = ?, legal_form = ?, rccm = ?, niu = ?, vat_number = ?, updated_at = ? WHERE id = ?`)
      .run(v.name, sector, v.country, v.currency, v.address, v.city, size, v.phone, email, v.website, v.legal_form, v.rccm, v.niu, v.vat_number, nowISO(), e.id);
    if (b.currency !== undefined && v.currency !== req.org.currency) await db.prepare('UPDATE orgs SET currency = ? WHERE id = ?').run(v.currency, req.org.id); // la monnaie de l'entreprise est celle des modules
  })();
  await audit(req, 'ent_info', e.id, 'update', { name: e.name, sector: e.sector, size: e.size }, { name: v.name, sector, size });
  res.json({ ok: true });
});

// ---------- Structure : lecture ----------
router.get('/chart', async (req, res) => {
  const o = req.org.id;
  const [dirs, depts, posts, asg, people, codes, dg] = await Promise.all([
    db.prepare('SELECT * FROM ent_directions WHERE org_id = ? ORDER BY sort, id').all(o),
    db.prepare('SELECT * FROM ent_departments WHERE org_id = ? ORDER BY sort, id').all(o),
    db.prepare('SELECT * FROM ent_posts WHERE org_id = ? ORDER BY sort, id').all(o),
    db.prepare('SELECT id, post_id, person_id FROM ent_assignments WHERE org_id = ?').all(o),
    peopleRows(req), inviteCodes(req),
    db.prepare('SELECT person_id FROM ent_dg WHERE entreprise_id = ?').all(req.ent.id),
  ]);
  const pv = new Map(people.map((p) => [Number(p.id), personView(req, p, codes)]));
  const holders = (postId) => asg.filter((a) => Number(a.post_id) === Number(postId) && pv.has(Number(a.person_id))).map((a) => ({ assignmentId: Number(a.id), personId: Number(a.person_id), name: pv.get(Number(a.person_id)).name, status: pv.get(Number(a.person_id)).status }));
  const postView = (p) => { const h = holders(p.id); return { id: Number(p.id), title: p.title, kind: p.kind, spaces: parseJSON(p.spaces, {}), headcount: Number(p.headcount), profileKey: p.profile_key || null, active: Boolean(Number(p.active)), holders: h, vacant: Math.max(Number(p.headcount) - h.length, 0), departmentId: p.department_id ? Number(p.department_id) : null, directionId: p.direction_id ? Number(p.direction_id) : null }; };
  const deptView = (d) => ({ id: Number(d.id), name: d.name, active: Boolean(Number(d.active)), directionId: d.direction_id ? Number(d.direction_id) : null, posts: posts.filter((p) => Number(p.department_id) === Number(d.id)).map(postView) });
  const dirView = (d) => ({ id: Number(d.id), name: d.name, active: Boolean(Number(d.active)), directors: posts.filter((p) => Number(p.direction_id) === Number(d.id) && !p.department_id).map(postView), departments: depts.filter((x) => Number(x.direction_id) === Number(d.id)).map(deptView) });
  const dgIds = new Set(dg.map((x) => Number(x.person_id)));
  res.json({
    entreprise: { id: Number(req.ent.id), name: req.ent.name },
    dg: [...dgIds].filter((id) => pv.has(id)).map((id) => pv.get(id)),
    directions: dirs.map(dirView),
    departments: depts.filter((d) => !d.direction_id).map(deptView), // départements sans direction du pilotage
    looseDirectors: posts.filter((p) => !p.department_id && !p.direction_id).map(postView),
    people: [...pv.values()].map((p) => ({ ...p, isDg: dgIds.has(p.id), posts: asg.filter((a) => Number(a.person_id) === p.id).map((a) => { const po = posts.find((x) => Number(x.id) === Number(a.post_id)); return po ? { assignmentId: Number(a.id), postId: Number(po.id), title: po.title } : null; }).filter(Boolean) })),
  });
});

// ---------- Modèle par secteur ----------
router.post('/template', A.need('admin'), async (req, res) => {
  const sector = A.oneOf((req.body || {}).sector, T.SECTOR_IDS, undefined, 'Choisissez un secteur.');
  const plan = T.planFor(sector); const o = req.org.id; const now = nowISO();
  const add = { directions: 0, departments: 0, posts: 0 };
  await db.transaction(async () => {
    const dirId = {};
    for (const d of plan.directions) {
      let row = await db.prepare('SELECT id FROM ent_directions WHERE org_id = ? AND tkey = ?').get(o, d.key);
      if (!row) { row = { id: (await db.prepare('INSERT INTO ent_directions (org_id, name, tkey, sort, active, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(o, d.name, d.key, d.sort, d.active ? 1 : 0, now)).lastInsertRowid }; add.directions++; }
      dirId[d.key] = Number(row.id);
      const have = await db.prepare('SELECT id FROM ent_posts WHERE org_id = ? AND tkey = ?').get(o, d.director.key);
      if (!have) { await db.prepare('INSERT INTO ent_posts (org_id, direction_id, title, kind, spaces, headcount, tkey, sort, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)').run(o, dirId[d.key], d.director.title, 'director', JSON.stringify(d.director.spaces), 1, d.director.key, 0, now); add.posts++; }
    }
    for (const d of plan.departments) {
      let row = await db.prepare('SELECT id FROM ent_departments WHERE org_id = ? AND tkey = ?').get(o, d.key);
      if (!row) { row = { id: (await db.prepare('INSERT INTO ent_departments (org_id, direction_id, name, tkey, sort, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(o, d.direction ? dirId[d.direction] : null, d.name, d.key, d.sort, d.active ? 1 : 0, now)).lastInsertRowid }; add.departments++; }
      for (const p of d.posts) {
        if (await db.prepare('SELECT 1 FROM ent_posts WHERE org_id = ? AND tkey = ?').get(o, d.key + '.' + p.key)) continue;
        await db.prepare('INSERT INTO ent_posts (org_id, department_id, title, kind, spaces, headcount, tkey, sort, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)').run(o, Number(row.id), p.title, p.kind, JSON.stringify(p.spaces), p.hc, d.key + '.' + p.key, p.sort, now); add.posts++;
      }
    }
    await db.prepare('UPDATE entreprises SET sector = ?, updated_at = ? WHERE id = ?').run(sector, now, req.ent.id);
    await db.prepare(`INSERT INTO ent_setup (org_id, steps, template, updated_by, updated_at) VALUES (?, '{}', ?, ?, ?)
      ON CONFLICT (org_id) DO UPDATE SET template = EXCLUDED.template, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`).run(o, sector, req.user.id, now);
  })();
  await audit(req, 'ent_template', req.ent.id, 'apply', null, { sector, ...add });
  res.json({ ok: true, sector, added: add });
});

// ---------- Direction générale (propriétaire) ----------
router.put('/dg', A.need('owner'), entWide, async (req, res) => {
  const ids = [...new Set((Array.isArray((req.body || {}).personIds) ? req.body.personIds : []).map((x) => A.id(x, 'Personne invalide.')))];
  if (!ids.length) throw new HttpError(400, 'La direction générale compte au moins une personne.');
  for (const id of ids) { // seulement des personnes de CETTE entreprise
    const p = await db.prepare("SELECT id FROM ent_people WHERE id = ? AND entreprise_id = ? AND status <> 'revoked'").get(id, req.ent.id);
    if (!p) throw new HttpError(404, 'Personne introuvable.');
  }
  const before = (await db.prepare('SELECT person_id FROM ent_dg WHERE entreprise_id = ?').all(req.ent.id)).map((r) => Number(r.person_id));
  await db.transaction(async () => {
    await db.prepare('DELETE FROM ent_dg WHERE entreprise_id = ?').run(req.ent.id);
    for (const id of ids) await db.prepare('INSERT INTO ent_dg (entreprise_id, person_id, created_at) VALUES (?, ?, ?)').run(req.ent.id, id, nowISO());
  })();
  await audit(req, 'ent_dg', req.ent.id, 'update', { personIds: before }, { personIds: ids });
  res.json({ ok: true });
});

// ---------- Directions du pilotage ----------
router.post('/directions', A.need('admin'), async (req, res) => {
  if (await count('SELECT COUNT(*) c FROM ent_directions WHERE org_id = ?', req.org.id) >= MAX.directions) throw new HttpError(403, `Limite de ${MAX.directions} directions atteinte.`);
  const name = pickName((req.body || {}).name, 'Indiquez le nom de la direction.');
  const sort = (await count('SELECT COALESCE(MAX(sort), 0) c FROM ent_directions WHERE org_id = ?', req.org.id)) + 1;
  const id = (await db.prepare('INSERT INTO ent_directions (org_id, name, sort, active, created_at) VALUES (?, ?, ?, 1, ?)').run(req.org.id, name, sort, nowISO())).lastInsertRowid;
  await audit(req, 'ent_direction', id, 'create', null, { name });
  res.status(201).json({ id: Number(id) });
});
router.put('/directions/:id', A.need('admin'), async (req, res) => {
  const d = await loadDir(req, req.params.id); const b = req.body || {};
  const name = b.name === undefined ? d.name : pickName(b.name, 'Le nom ne peut pas être vide.');
  await db.prepare('UPDATE ent_directions SET name = ?, active = ? WHERE id = ?').run(name, flag(b.active, d.active), d.id);
  await audit(req, 'ent_direction', d.id, 'update', { name: d.name, active: Number(d.active) }, { name, active: flag(b.active, d.active) });
  res.json({ ok: true });
});
router.delete('/directions/:id', A.need('admin'), async (req, res) => {
  const d = await loadDir(req, req.params.id);
  if (await count('SELECT COUNT(*) c FROM ent_assignments a JOIN ent_posts p ON p.id = a.post_id WHERE p.direction_id = ?', d.id)) throw new HttpError(409, "Cette direction a des personnes affectées : retirez-les d'abord, ou désactivez la direction.");
  await db.transaction(async () => {
    await db.prepare('DELETE FROM ent_posts WHERE direction_id = ? AND department_id IS NULL AND org_id = ?').run(d.id, req.org.id);
    await db.prepare('DELETE FROM ent_directions WHERE id = ? AND org_id = ?').run(d.id, req.org.id);
  })();
  await audit(req, 'ent_direction', d.id, 'delete', { name: d.name }, null);
  res.json({ ok: true });
});

// ---------- Départements ----------
router.post('/departments', A.need('admin'), async (req, res) => {
  if (await count('SELECT COUNT(*) c FROM ent_departments WHERE org_id = ?', req.org.id) >= MAX.departments) throw new HttpError(403, `Limite de ${MAX.departments} départements atteinte.`);
  const b = req.body || {}; const name = pickName(b.name, 'Indiquez le nom du département.');
  const sort = (await count('SELECT COALESCE(MAX(sort), 0) c FROM ent_departments WHERE org_id = ?', req.org.id)) + 1;
  const id = (await db.prepare('INSERT INTO ent_departments (org_id, direction_id, name, sort, active, created_at) VALUES (?, ?, ?, ?, 1, ?)').run(req.org.id, await dirOrNull(req, b.directionId), name, sort, nowISO())).lastInsertRowid;
  await audit(req, 'ent_department', id, 'create', null, { name });
  res.status(201).json({ id: Number(id) });
});
router.put('/departments/:id', A.need('admin'), async (req, res) => {
  const d = await loadDept(req, req.params.id); const b = req.body || {};
  const name = b.name === undefined ? d.name : pickName(b.name, 'Le nom ne peut pas être vide.');
  const dir = b.directionId === undefined ? d.direction_id : await dirOrNull(req, b.directionId);
  await db.prepare('UPDATE ent_departments SET name = ?, direction_id = ?, active = ? WHERE id = ?').run(name, dir, flag(b.active, d.active), d.id);
  await audit(req, 'ent_department', d.id, 'update', { name: d.name, directionId: d.direction_id, active: Number(d.active) }, { name, directionId: dir, active: flag(b.active, d.active) });
  res.json({ ok: true });
});
router.delete('/departments/:id', A.need('admin'), async (req, res) => {
  const d = await loadDept(req, req.params.id);
  if (await count('SELECT COUNT(*) c FROM ent_assignments a JOIN ent_posts p ON p.id = a.post_id WHERE p.department_id = ?', d.id)) throw new HttpError(409, "Ce département a des personnes affectées : retirez-les d'abord, ou désactivez le département.");
  await db.transaction(async () => {
    await db.prepare('DELETE FROM ent_posts WHERE department_id = ? AND org_id = ?').run(d.id, req.org.id);
    await db.prepare('DELETE FROM ent_departments WHERE id = ? AND org_id = ?').run(d.id, req.org.id);
  })();
  await audit(req, 'ent_department', d.id, 'delete', { name: d.name }, null);
  res.json({ ok: true });
});

// ---------- Postes ----------
router.post('/posts', A.need('admin'), async (req, res) => {
  if (await count('SELECT COUNT(*) c FROM ent_posts WHERE org_id = ?', req.org.id) >= MAX.posts) throw new HttpError(403, `Limite de ${MAX.posts} postes atteinte.`);
  const b = req.body || {};
  const title = pickName(b.title, 'Indiquez le titre du poste.');
  const dept = await deptOrNull(req, b.departmentId); const dir = dept ? null : await dirOrNull(req, b.directionId);
  const kind = A.oneOf(b.kind, KINDS, 'staff', 'Type de poste inconnu.');
  const spaces = cleanSpaces(req, b.spaces === undefined ? {} : b.spaces);
  const hc = Math.min(Math.max(parseInt(b.headcount, 10) || 1, 1), 200);
  const sort = (await count('SELECT COALESCE(MAX(sort), 0) c FROM ent_posts WHERE org_id = ?', req.org.id)) + 1;
  const id = (await db.prepare('INSERT INTO ent_posts (org_id, direction_id, department_id, title, kind, spaces, headcount, sort, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)').run(req.org.id, dir, dept, title, kind, JSON.stringify(spaces), hc, sort, nowISO())).lastInsertRowid;
  await audit(req, 'ent_post', id, 'create', null, { title, kind, spaces, headcount: hc });
  res.status(201).json({ id: Number(id) });
});
router.put('/posts/:id', A.need('admin'), async (req, res) => {
  const p = await loadPost(req, req.params.id); const b = req.body || {};
  const title = b.title === undefined ? p.title : pickName(b.title, 'Le titre ne peut pas être vide.');
  const kind = b.kind === undefined ? p.kind : A.oneOf(b.kind, KINDS, undefined, 'Type de poste inconnu.');
  const spaces = b.spaces === undefined ? undefined : cleanSpaces(req, b.spaces);
  const before = parseJSON(p.spaces, {});
  // Un administrateur ne peut pas retirer ni modifier à la place du propriétaire la responsabilité de l'espace compte déjà donnée : on ne touche qu'à ce qu'on a le droit de donner.
  if (spaces !== undefined && !A.can(req, 'owner') && before.compte === 'manage' && spaces.compte !== 'manage') throw new HttpError(403, "Seul le propriétaire peut modifier la responsabilité de l'espace Administration du compte.");
  const hc = b.headcount === undefined ? Number(p.headcount) : Math.min(Math.max(parseInt(b.headcount, 10) || 1, 1), 200);
  const used = await count('SELECT COUNT(*) c FROM ent_assignments WHERE post_id = ?', p.id);
  if (hc < used) throw new HttpError(409, `Ce poste a déjà ${used} personne(s) affectée(s) : retirez-en d'abord.`);
  const dept = b.departmentId === undefined ? p.department_id : await deptOrNull(req, b.departmentId);
  const dir = dept ? null : (b.directionId === undefined ? p.direction_id : await dirOrNull(req, b.directionId));
  const after = spaces === undefined ? before : spaces;
  await db.prepare('UPDATE ent_posts SET title = ?, kind = ?, spaces = ?, headcount = ?, department_id = ?, direction_id = ?, active = ? WHERE id = ?').run(title, kind, JSON.stringify(after), hc, dept, dir, flag(b.active, p.active), p.id);
  await audit(req, 'ent_post', p.id, 'update', { title: p.title, kind: p.kind, spaces: before, headcount: Number(p.headcount), active: Number(p.active) }, { title, kind, spaces: after, headcount: hc, active: flag(b.active, p.active) });
  res.json({ ok: true });
});
router.delete('/posts/:id', A.need('admin'), async (req, res) => {
  const p = await loadPost(req, req.params.id);
  if (await count('SELECT COUNT(*) c FROM ent_assignments WHERE post_id = ?', p.id)) throw new HttpError(409, "Ce poste a des personnes affectées : retirez-les d'abord, ou désactivez le poste.");
  await db.prepare('DELETE FROM ent_posts WHERE id = ? AND org_id = ?').run(p.id, req.org.id);
  await audit(req, 'ent_post', p.id, 'delete', { title: p.title }, null);
  res.json({ ok: true });
});

// ---------- Personnes et invitations personnelles ----------
router.get('/people', async (req, res) => {
  const codes = await inviteCodes(req);
  res.json({ people: (await peopleRows(req)).map((p) => personView(req, p, codes)) });
});

router.post('/people', A.need('admin'), async (req, res) => {
  const b = req.body || {};
  if (await count("SELECT COUNT(*) c FROM ent_people WHERE entreprise_id = ? AND status <> 'revoked'", req.ent.id) >= MAX.people) throw new HttpError(403, `Limite de ${MAX.people} personnes atteinte.`);
  const fullName = A.text(b.fullName, 120, { required: true, msg: 'Indiquez le nom de la personne.' });
  const email = A.text(b.email, 120); const phone = A.text(b.phone, 40);
  if (email && !EMAIL.test(email)) throw new HttpError(400, 'Adresse e-mail invalide.');
  if (email && await db.prepare("SELECT 1 FROM ent_people WHERE entreprise_id = ? AND lower(email) = lower(?) AND status <> 'revoked'").get(req.ent.id, email)) throw new HttpError(409, 'Une personne de cette entreprise a déjà cette adresse e-mail.');
  const role = A.oneOf(b.role, ['member', 'manager', 'admin'], 'member', 'Rôle inconnu.');
  if (role === 'admin' && !A.can(req, 'owner')) throw new HttpError(403, 'Seul le propriétaire peut inviter un administrateur.');
  const postIds = [...new Set((Array.isArray(b.postIds) ? b.postIds : []).map((x) => A.id(x, 'Poste invalide.')))];
  const posts = [];
  for (const pid of postIds) posts.push(await loadPost(req, pid)); // un poste d'une autre organisation est refusé (introuvable)
  const code = crypto.randomBytes(5).toString('hex').toUpperCase();
  const days = Math.min(Math.max(Number(b.days) || 14, 1), 30);
  const title = A.text(b.title, 80) || (posts[0] ? posts[0].title.slice(0, 80) : '');
  const now = nowISO();
  const id = await db.transaction(async () => {
    await db.prepare('INSERT INTO invites (org_id, code, role, title, branch_id, created_by, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(req.org.id, code, role, title, null, req.user.id, new Date(Date.now() + days * 86400000).toISOString(), now);
    const pid = (await db.prepare("INSERT INTO ent_people (entreprise_id, full_name, email, phone, status, invite_code, invite_org_id, created_by, created_at) VALUES (?, ?, ?, ?, 'invited', ?, ?, ?, ?)")
      .run(req.ent.id, fullName, email, phone, code, req.org.id, req.user.id, now)).lastInsertRowid;
    for (const p of posts) await assign(req, p, Number(pid));
    return Number(pid);
  })();
  await audit(req, 'ent_person', id, 'create', null, { name: fullName, role, postIds }); // le code d'invitation n'est jamais écrit dans le journal
  res.status(201).json({ id, code });
});

router.post('/people/:id/invite', A.need('admin'), async (req, res) => {
  const p = await db.prepare('SELECT * FROM ent_people WHERE id = ? AND entreprise_id = ?').get(A.id(req.params.id), req.ent.id);
  if (!p) throw new HttpError(404, 'Personne introuvable.');
  if (p.user_id) throw new HttpError(409, 'Cette personne a déjà rejoint : rien à renvoyer.');
  const old = p.invite_code ? await db.prepare('SELECT role, title FROM invites WHERE code = ? AND org_id = ?').get(p.invite_code, req.org.id) : null;
  const code = crypto.randomBytes(5).toString('hex').toUpperCase();
  await db.transaction(async () => {
    if (p.invite_code) await db.prepare('DELETE FROM invites WHERE org_id = ? AND code = ?').run(req.org.id, p.invite_code);
    await db.prepare('INSERT INTO invites (org_id, code, role, title, branch_id, created_by, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(req.org.id, code, old ? old.role : 'member', old ? old.title : '', null, req.user.id, new Date(Date.now() + 14 * 86400000).toISOString(), nowISO());
    await db.prepare('UPDATE ent_people SET invite_code = ?, invite_org_id = ? WHERE id = ?').run(code, req.org.id, p.id);
  })();
  await audit(req, 'ent_person', p.id, 'reinvite', null, { name: p.full_name });
  res.json({ code });
});

router.put('/people/:id', A.need('admin'), async (req, res) => {
  const p = await db.prepare('SELECT * FROM ent_people WHERE id = ? AND entreprise_id = ?').get(A.id(req.params.id), req.ent.id);
  if (!p) throw new HttpError(404, 'Personne introuvable.');
  const b = req.body || {};
  const email = b.email === undefined ? p.email : A.text(b.email, 120);
  if (email && !EMAIL.test(email)) throw new HttpError(400, 'Adresse e-mail invalide.');
  await db.prepare('UPDATE ent_people SET full_name = ?, email = ?, phone = ? WHERE id = ?').run(b.fullName === undefined ? p.full_name : A.text(b.fullName, 120, { required: true, msg: 'Le nom ne peut pas être vide.' }), email, b.phone === undefined ? p.phone : A.text(b.phone, 40), p.id);
  await audit(req, 'ent_person', p.id, 'update', { name: p.full_name }, { name: b.fullName === undefined ? p.full_name : b.fullName });
  res.json({ ok: true });
});

router.delete('/people/:id', A.need('admin'), async (req, res) => {
  const p = await db.prepare('SELECT * FROM ent_people WHERE id = ? AND entreprise_id = ?').get(A.id(req.params.id), req.ent.id);
  if (!p) throw new HttpError(404, 'Personne introuvable.');
  if (p.user_id) throw new HttpError(409, "Cette personne a déjà rejoint l'équipe : pour la retirer, utilisez « Équipe et antennes ».");
  if (await count('SELECT COUNT(*) c FROM ent_dg WHERE entreprise_id = ? AND person_id = ?', req.ent.id, p.id)) throw new HttpError(409, 'Retirez-la d\'abord de la direction générale.');
  await db.transaction(async () => {
    if (p.invite_code) await db.prepare('DELETE FROM invites WHERE org_id = ? AND code = ?').run(req.org.id, p.invite_code);
    await db.prepare('DELETE FROM ent_people WHERE id = ?').run(p.id); // les affectations partent en cascade
  })();
  await audit(req, 'ent_person', p.id, 'delete', { name: p.full_name }, null);
  res.json({ ok: true });
});

// ---------- Affectations (PAR organisation) ----------
async function assign(req, post, personId) {
  const p = await db.prepare("SELECT * FROM ent_people WHERE id = ? AND entreprise_id = ? AND status <> 'revoked'").get(personId, req.ent.id);
  if (!p) throw new HttpError(404, 'Personne introuvable.');
  const inOrg = p.user_id ? await db.prepare('SELECT * FROM org_members WHERE org_id = ? AND user_id = ?').get(req.org.id, p.user_id) : null;
  if (!inOrg && !(Number(p.invite_org_id) === Number(req.org.id) && !p.user_id)) throw new HttpError(400, "Cette personne ne fait pas partie de cette organisation : invitez-la d'abord.");
  if (!Number(post.active)) throw new HttpError(400, 'Ce poste est désactivé : activez-le pour y affecter quelqu\'un.');
  const spaces = parseJSON(post.spaces, {});
  if (spaces.compte === 'manage' && !A.can(req, 'owner')) throw new HttpError(403, "Seul le propriétaire peut affecter à un poste responsable de l'espace Administration du compte.");
  if (await db.prepare('SELECT 1 FROM ent_assignments WHERE post_id = ? AND person_id = ?').get(post.id, personId)) return null;
  if (await count('SELECT COUNT(*) c FROM ent_assignments WHERE post_id = ?', post.id) >= Number(post.headcount)) throw new HttpError(409, 'Toutes les places de ce poste sont prises : augmentez le nombre de places ou choisissez un autre poste.');
  const id = (await db.prepare('INSERT INTO ent_assignments (org_id, post_id, person_id, created_by, created_at) VALUES (?, ?, ?, ?, ?)').run(req.org.id, post.id, personId, req.user.id, nowISO())).lastInsertRowid;
  if (inOrg && !inOrg.title) await db.prepare('UPDATE org_members SET title = ? WHERE id = ?').run(post.title.slice(0, 80), inOrg.id); // l'intitulé de la personne reprend son poste s'il était vide
  await audit(req, 'ent_assignment', id, 'assign', null, { postId: Number(post.id), post: post.title, personId });
  return Number(id);
}
router.post('/assignments', A.need('admin'), async (req, res) => {
  const b = req.body || {};
  const post = await loadPost(req, b.postId);
  const id = await db.transaction(async () => assign(req, post, A.id(b.personId, 'Personne invalide.')))();
  res.status(201).json({ id });
});
router.delete('/assignments/:id', A.need('admin'), async (req, res) => {
  const a = await db.prepare('SELECT a.*, p.title FROM ent_assignments a JOIN ent_posts p ON p.id = a.post_id WHERE a.id = ? AND a.org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!a) throw new HttpError(404, 'Affectation introuvable.');
  await db.prepare('DELETE FROM ent_assignments WHERE id = ? AND org_id = ?').run(a.id, req.org.id);
  await audit(req, 'ent_assignment', a.id, 'unassign', { post: a.title, personId: Number(a.person_id) }, null);
  res.json({ ok: true });
});

// ---------- Avancement de la configuration et lien avec les droits ----------
const STEPS = ['info', 'dg', 'directions', 'departments', 'people'];
router.put('/setup', A.need('admin'), async (req, res) => {
  const b = req.body || {};
  const step = A.oneOf(b.step, STEPS, undefined, 'Étape inconnue.');
  const status = A.oneOf(b.status, ['done', 'skipped', 'todo'], undefined, 'État inconnu.');
  const cur = await E.setupOf(req.org.id);
  const steps = { ...cur.steps, [step]: status };
  const complete = STEPS.every((s) => steps[s] === 'done' || steps[s] === 'skipped');
  await db.prepare(`INSERT INTO ent_setup (org_id, steps, template, rights_link, updated_by, updated_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (org_id) DO UPDATE SET steps = EXCLUDED.steps, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at, completed_at = EXCLUDED.completed_at`)
    .run(req.org.id, JSON.stringify(steps), cur.template, cur.rightsLink ? 1 : 0, req.user.id, nowISO(), complete ? (cur.completedAt || nowISO()) : null);
  res.json({ ok: true, steps, completed: complete });
});
/** Retour arrière par entreprise : couper le lien « affectation → espaces » (la structure reste, les accès reviennent à ce qu'ils étaient sans elle). */
router.post('/company-code', A.need('owner'), entWide, async (req, res) => {
  const code = await AL.regenerateCompanyCode(req.ent);
  await audit(req, 'ent_settings', req.ent.id, 'company_code', null, null);
  res.json({ companyCode: AL.display(code) });
});
router.get('/devices', A.need('admin'), async (req, res) => {
  const rows = await db.prepare(`SELECT d.id, d.label, d.created_at, d.last_seen, d.expires_at, p.full_name, p.id AS person_id FROM ent_devices d JOIN ent_people p ON p.id = d.person_id
    WHERE p.entreprise_id = ? AND d.revoked_at IS NULL AND d.expires_at > ? AND EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = ? AND m.user_id = p.user_id) ORDER BY d.last_seen DESC`).all(req.ent.id, nowISO(), req.org.id);
  res.json({ devices: rows.map((d) => ({ id: Number(d.id), person: d.full_name, personId: Number(d.person_id), label: d.label, createdAt: d.created_at, lastSeen: d.last_seen, expiresAt: d.expires_at })) });
});
router.delete('/devices/:id', A.need('admin'), async (req, res) => {
  const d = await db.prepare('SELECT d.* FROM ent_devices d JOIN ent_people p ON p.id = d.person_id WHERE d.id = ? AND p.entreprise_id = ? AND EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = ? AND m.user_id = p.user_id)').get(A.id(req.params.id), req.ent.id, req.org.id);
  if (!d) throw new HttpError(404, 'Appareil introuvable.');
  await require('../routes/entreprise-auth').revokeDevice(d, 'administrateur');
  await audit(req, 'ent_device', d.id, 'revoke', { personId: Number(d.person_id) }, null);
  res.json({ ok: true });
});
router.put('/settings', A.need('owner'), async (req, res) => {
  if ((req.body || {}).sensitive2fa !== undefined) {
    if (!await LK.canManage(req, req.ent)) throw new HttpError(403, "Réservé à la direction générale et à l'organisation principale de l'entreprise.");
    await db.prepare('UPDATE entreprises SET sensitive_2fa = ? WHERE id = ?').run(req.body.sensitive2fa ? 1 : 0, req.ent.id);
    await audit(req, 'ent_settings', req.ent.id, 'update', null, { sensitive2fa: Boolean(req.body.sensitive2fa) });
    if ((req.body || {}).rightsLink === undefined) return res.json({ ok: true, sensitive2fa: Boolean(req.body.sensitive2fa) });
  }
  const cur = await E.setupOf(req.org.id);
  const link = (req.body || {}).rightsLink === undefined ? cur.rightsLink : Boolean((req.body || {}).rightsLink);
  await db.prepare(`INSERT INTO ent_setup (org_id, steps, template, rights_link, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (org_id) DO UPDATE SET rights_link = EXCLUDED.rights_link, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`)
    .run(req.org.id, JSON.stringify(cur.steps), cur.template, link ? 1 : 0, req.user.id, nowISO());
  await audit(req, 'ent_settings', req.org.id, 'update', { rightsLink: cur.rightsLink }, { rightsLink: link });
  res.json({ ok: true, rightsLink: link, globalOff: E.globalOff() });
});

// ---------- Organisations liées (étape 4) ----------
router.get('/links', async (req, res) => {
  const manage = await LK.canManage(req, req.ent);
  const orgs = await db.prepare('SELECT id, name, linked_via, created_at, owner_id FROM orgs WHERE entreprise_id = ? ORDER BY id').all(req.ent.id);
  const main = await LK.mainOrgOf(req.ent);
  const out = { main: Number(main.id) === Number(req.org.id), mainOrgId: manage ? Number(main.id) : undefined, canManage: manage, current: { id: Number(req.org.id), name: req.org.name } };
  if (!manage) return res.json(out); // une organisation liée voit seulement sa propre place ; la liste est pour la direction générale
  const links = await db.prepare('SELECT id, hint, label, copy_structure, created_at, expires_at, used_at, used_org_id, revoked_at FROM ent_links WHERE entreprise_id = ? ORDER BY id DESC LIMIT 50').all(req.ent.id);
  const members = await db.prepare('SELECT org_id, COUNT(*) c FROM org_members WHERE org_id IN (SELECT id FROM orgs WHERE entreprise_id = ?) GROUP BY org_id').all(req.ent.id);
  const owner = await require('../db').getUserFresh(req.ent.owner_user_id);
  const lim = A.limitsFor((owner || {}).plan || 'Gratuit');
  res.json({ ...out,
    orgs: orgs.map((o) => ({ id: Number(o.id), name: o.name, main: Number(o.id) === Number(main.id), linked: Boolean(o.linked_via), createdAt: o.created_at, members: Number((members.find((x) => Number(x.org_id) === Number(o.id)) || {}).c) || 0 })),
    links: links.map((l) => { const st = l.revoked_at ? 'revoked' : l.used_at ? 'used' : Date.parse(l.expires_at) < Date.now() ? 'expired' : 'pending'; return { id: Number(l.id), hint: l.hint, label: l.label, copyStructure: Boolean(Number(l.copy_structure)), createdAt: l.created_at, expiresAt: l.expires_at, status: st, usedOrgId: l.used_org_id ? Number(l.used_org_id) : null }; }),
    limits: { orgs: lim.orgs, orgsUsed: orgs.length },
    log: (await db.prepare('SELECT l.action, l.detail, l.created_at AS at, u.name FROM ent_link_log l LEFT JOIN users u ON u.id = l.user_id WHERE l.entreprise_id = ? ORDER BY l.id DESC LIMIT 30').all(req.ent.id)),
  });
});
router.post('/links', A.need('admin'), entWide, async (req, res) => {
  await LK.assertOrgRoom(req.ent); // pas de lien si la limite d'organisations de l'abonnement est déjà atteinte
  const l = await LK.createLink(req, req.ent, { label: (req.body || {}).label, days: (req.body || {}).days, copyStructure: (req.body || {}).copyStructure });
  await audit(req, 'ent_link', l.id, 'create', null, { label: A.text((req.body || {}).label, 80) });
  res.status(201).json({ id: l.id, code: l.token, expiresAt: l.expiresAt }); // le code n'est montré qu'une fois : seule son empreinte est conservée
});
router.delete('/links/:id', A.need('admin'), entWide, async (req, res) => {
  const r = await db.prepare('UPDATE ent_links SET revoked_at = ? WHERE id = ? AND entreprise_id = ? AND used_at IS NULL AND revoked_at IS NULL').run(nowISO(), A.id(req.params.id), req.ent.id);
  if (!r.changes) throw new HttpError(404, 'Lien introuvable, déjà utilisé ou déjà révoqué.');
  await LK.log(req.ent.id, null, A.id(req.params.id), req.user.id, 'link_revoked');
  await audit(req, 'ent_link', A.id(req.params.id), 'revoke', null, null);
  res.json({ ok: true });
});
router.get('/people-elsewhere', A.need('admin'), entWide, async (req, res) => {
  const rows = await db.prepare(`SELECT p.id, p.full_name FROM ent_people p WHERE p.entreprise_id = ? AND p.user_id IS NOT NULL AND p.status = 'active'
    AND NOT EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = ? AND m.user_id = p.user_id) ORDER BY p.full_name`).all(req.ent.id, req.org.id);
  res.json({ people: rows.map((r) => ({ id: Number(r.id), name: r.full_name })) });
});
/** Direction générale : fait entrer dans CETTE organisation une personne de l'entreprise (déjà dans une autre organisation liée). Ses affectations restent propres à chaque organisation. */
router.post('/people/:id/enroll', A.need('admin'), entWide, async (req, res) => {
  const p = await db.prepare("SELECT * FROM ent_people WHERE id = ? AND entreprise_id = ? AND user_id IS NOT NULL AND status = 'active'").get(A.id(req.params.id), req.ent.id);
  if (!p) throw new HttpError(404, 'Personne introuvable.');
  if (await db.prepare('SELECT 1 FROM org_members WHERE org_id = ? AND user_id = ?').get(req.org.id, p.user_id)) throw new HttpError(409, 'Cette personne fait déjà partie de cette organisation.');
  if (Number((await db.prepare('SELECT COUNT(*) c FROM org_members WHERE org_id = ?').get(req.org.id)).c) >= A.limitsFor(await A.ownerPlan(req.org)).members) throw new HttpError(403, "Cette organisation a atteint le nombre de personnes permis par l'offre de l'entreprise.");
  const role = A.oneOf((req.body || {}).role, ['member', 'manager'], 'member', 'Rôle inconnu.');
  await db.prepare('INSERT INTO org_members (org_id, user_id, role, title, created_at) VALUES (?, ?, ?, ?, ?)').run(req.org.id, p.user_id, role, A.text((req.body || {}).title, 80), nowISO());
  await audit(req, 'ent_person', p.id, 'enroll', null, { name: p.full_name, role });
  await LK.log(req.ent.id, req.org.id, null, req.user.id, 'person_enrolled', p.full_name);
  res.status(201).json({ ok: true });
});

// ---------- Profils de rôle (étape 3) : le profil ne donne aucun droit, il organise l'écran de la personne ----------
const moduleIds = () => require('./modules').modules.map((m) => m.id);
router.get('/profiles', async (req, res) => {
  const list = await PR.profilesOf(req.org.id);
  const used = await db.prepare('SELECT title, tkey, profile_key FROM ent_posts WHERE org_id = ? AND active = 1').all(req.org.id);
  res.json({
    profiles: list.map((p) => ({ key: p.key, title: p.title, desc: p.desc, custom: p.custom, config: p.config, posts: used.filter((x) => PR.keyOfPost(x) === p.key).map((x) => x.title) })),
    catalogue: { blockTypes: PR.BLOCK_TYPES, spaces: E.SPACE_IDS, lists: Object.entries(PR.SOURCES).map(([key, s]) => ({ key, title: s.title, module: s.module })), components: Object.entries(PR.COMPONENTS).map(([key, module]) => ({ key, module })), layouts: PR.LAYOUTS, modules: require('./modules').modules.map((m) => ({ id: m.id, title: m.title })) },
    can: { edit: A.can(req, 'admin') },
  });
});
router.put('/profiles/:key', A.need('admin'), async (req, res) => {
  const key = String(req.params.key);
  if (!PR.BASE[key]) throw new HttpError(404, 'Profil introuvable.');
  const cfg = PR.cleanConfig((req.body || {}).config, moduleIds(), HttpError);
  const before = (await PR.profilesOf(req.org.id)).find((p) => p.key === key);
  await db.prepare(`INSERT INTO ent_profiles (org_id, key, config, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (org_id, key) DO UPDATE SET config = EXCLUDED.config, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`).run(req.org.id, key, JSON.stringify(cfg), req.user.id, nowISO());
  await audit(req, 'ent_profile', req.org.id, 'update', { key, blocks: before.config.blocks.length }, { key, blocks: cfg.blocks.length, modules: cfg.modules.length });
  res.json({ ok: true });
});
router.delete('/profiles/:key', A.need('admin'), async (req, res) => {
  const key = String(req.params.key);
  if (!PR.BASE[key]) throw new HttpError(404, 'Profil introuvable.');
  await db.prepare('DELETE FROM ent_profiles WHERE org_id = ? AND key = ?').run(req.org.id, key);
  await audit(req, 'ent_profile', req.org.id, 'reset', { key }, null);
  res.json({ ok: true });
});
router.put('/posts/:id/profile', A.need('admin'), async (req, res) => {
  const p = await loadPost(req, req.params.id);
  const key = (req.body || {}).key;
  if (key !== null && key !== undefined && key !== '' && !PR.BASE[key]) throw new HttpError(400, 'Profil inconnu.');
  const v = key ? key : null;
  await db.prepare('UPDATE ent_posts SET profile_key = ? WHERE id = ?').run(v, p.id);
  if ((req.body || {}).applyRights === true && v) { // reprendre les accès par défaut du profil (jamais « responsable du compte » sans être propriétaire)
    const spaces = cleanSpaces(req, PR.BASE[v].config.spaces);
    await db.prepare('UPDATE ent_posts SET spaces = ? WHERE id = ?').run(JSON.stringify(spaces), p.id);
  }
  await audit(req, 'ent_post', p.id, 'profile', { profile: p.profile_key || null }, { profile: v });
  res.json({ ok: true });
});
/** Mon profil : celui de mon poste, avec seulement les blocs, modules et actions auxquels j'ai accès. */
router.get('/my-profile', async (req, res) => {
  const { key, posts } = await PR.profileKeyFor(req);
  const sp = require('./spaces');
  const mine = { posts: posts.map((x) => x.title) };
  if (!key) return res.json({ profile: null, ...mine });
  const profile = (await PR.profilesOf(req.org.id)).find((p) => p.key === key);
  const r = await PR.resolve(req, profile, await sp.forMember(req), sp.dashboardOf);
  res.json({ profile: { key, title: profile.title, desc: profile.desc, layout: profile.config.mobile.layout, custom: profile.custom }, ...r, ...mine });
});

router.get('/log', A.need('admin'), async (req, res) => {
  const rows = await db.prepare(`SELECT l.entity, l.action, l.after_json AS after, l.before_json AS before, l.created_at AS at, u.name FROM audit_log l LEFT JOIN users u ON u.id = l.user_id
    WHERE l.org_id = ? AND l.entity LIKE 'ent\\_%' ESCAPE '\\' ORDER BY l.id DESC LIMIT 100`).all(req.org.id);
  res.json({ log: rows });
});

module.exports = { router };
