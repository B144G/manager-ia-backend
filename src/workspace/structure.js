'use strict';
// Sous-applications « Organisation » (postes et hiérarchie) et « Fonctionnement » (procédures).
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const W = require('./w3');
const { HttpError, parseJSON } = require('../util');

const router = express.Router({ mergeParams: true });

// ---------- Postes ----------
const posRow = (p) => ({ id: p.id, title: p.title, description: p.description, parentId: p.parent_id, holderId: p.holder_id, holder: p.holder || null, branchId: p.branch_id });

router.get('/positions', async (req, res) => {
  const rows = await db.prepare('SELECT p.*, u.name AS holder FROM positions p LEFT JOIN users u ON u.id = p.holder_id WHERE p.org_id = ? ORDER BY p.id').all(req.org.id);
  res.json({ positions: rows.map(posRow) });
});

async function checkParent(req, parentId, selfId) {
  const pid = A.idOrNull(parentId, 'Poste supérieur invalide.');
  if (pid === null) return null;
  if (!await db.prepare('SELECT 1 FROM positions WHERE id = ? AND org_id = ?').get(pid, req.org.id)) throw new HttpError(400, 'Poste supérieur inconnu.');
  // Pas de boucle dans la hiérarchie.
  for (let cur = pid, n = 0; cur && n < 50; n++) {
    if (cur === selfId) throw new HttpError(400, 'Un poste ne peut pas dépendre de lui-même.');
    cur = (await db.prepare('SELECT parent_id FROM positions WHERE id = ?').get(cur) || {}).parent_id;
  }
  return pid;
}

router.post('/positions', A.need('admin'), async (req, res) => {
  const b = req.body || {};
  const count = (await db.prepare('SELECT COUNT(*) c FROM positions WHERE org_id = ?').get(req.org.id)).c;
  if (count >= 200) throw new HttpError(403, 'Limite de 200 postes atteinte.');
  const id = (await db.prepare('INSERT INTO positions (org_id, branch_id, title, description, parent_id, holder_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    req.org.id, await A.branchOf(req, b.branchId), A.text(b.title, 100, { required: true, msg: 'Indiquez le titre du poste.' }), A.text(b.description, 1000), await checkParent(req, b.parentId, null), await A.memberOf(req, b.holderId), nowISO())).lastInsertRowid;
  res.status(201).json({ id: Number(id) });
});

router.put('/positions/:id', A.need('admin'), async (req, res) => {
  const p = await db.prepare('SELECT * FROM positions WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!p) throw new HttpError(404, 'Poste introuvable.');
  const b = req.body || {};
  await db.prepare('UPDATE positions SET title = ?, description = ?, parent_id = ?, holder_id = ?, branch_id = ? WHERE id = ?').run(
    b.title === undefined ? p.title : A.text(b.title, 100, { required: true, msg: 'Le titre ne peut pas être vide.' }),
    b.description === undefined ? p.description : A.text(b.description, 1000),
    b.parentId === undefined ? p.parent_id : await checkParent(req, b.parentId, p.id),
    b.holderId === undefined ? p.holder_id : await A.memberOf(req, b.holderId),
    b.branchId === undefined ? p.branch_id : await A.branchOf(req, b.branchId), p.id);
  res.json({ ok: true });
});

router.delete('/positions/:id', A.need('admin'), async (req, res) => {
  const r = await db.prepare('DELETE FROM positions WHERE id = ? AND org_id = ?').run(A.id(req.params.id), req.org.id);
  if (!r.changes) throw new HttpError(404, 'Poste introuvable.');
  res.json({ ok: true });
});

/** Crée plusieurs postes d'un coup (proposition de l'IA validée). `reportsTo` désigne un titre de la même liste ou un poste existant. */
async function createPositions(req, list) {
  if (!Array.isArray(list) || !list.length || list.length > 40) throw new HttpError(400, 'Liste de postes invalide.');
  const existing = await db.prepare('SELECT id, title FROM positions WHERE org_id = ?').all(req.org.id);
  const byTitle = new Map(existing.map((p) => [p.title.toLowerCase(), p.id]));
  const now = nowISO();
  let created = 0;
  await db.transaction(async () => {
    for (const p of list) {
      const title = A.text(p && p.title, 100);
      if (!title || byTitle.has(title.toLowerCase())) continue; // pas de doublon
      const parent = p.reportsTo ? byTitle.get(String(p.reportsTo).trim().toLowerCase()) || null : null;
      const id = (await db.prepare('INSERT INTO positions (org_id, title, description, parent_id, created_at) VALUES (?, ?, ?, ?, ?)').run(req.org.id, title, A.text(p.description, 1000), parent, now)).lastInsertRowid;
      byTitle.set(title.toLowerCase(), Number(id));
      created++;
    }
  })();
  await A.logActivity(req.org.id, req.user.id, 'structure', `${created} poste(s) ajouté(s) à l'organigramme`);
  return created;
}

// ---------- Procédures ----------
const procRow = (p) => ({ id: p.id, title: p.title, category: p.category, steps: parseJSON(p.steps, []), updatedAt: p.updated_at, version: Number(p.version || 1), ownerId: p.owner_id, owner: p.owner || null,
  reviewMonths: Number(p.review_months || 0), nextReview: p.next_review, reviewDue: Boolean(p.next_review) && p.next_review < nowISO().slice(0, 10), readByMe: Boolean(Number(p.read_me || 0)), readers: Number(p.readers || 0) });
const reviewMonths = (v) => { const n = Math.round(Number(v || 0)); if (!Number.isFinite(n) || n < 0 || n > 60) throw new HttpError(400, 'Révision : 0 à 60 mois.'); return n; };
const addMonths = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCMonth(x.getUTCMonth() + n); return x.toISOString().slice(0, 10); };
function cleanSteps(v) {
  if (!Array.isArray(v) || v.length > 40) throw new HttpError(400, 'Étapes invalides (40 maximum).');
  const out = v.map((s) => A.text(typeof s === 'string' ? s : s && s.text, 300)).filter(Boolean);
  if (!out.length) throw new HttpError(400, 'Ajoutez au moins une étape.');
  return out;
}

router.get('/processes', async (req, res) => {
  res.json({ processes: (await db.prepare(`SELECT p.*, u.name AS owner,
    (SELECT COUNT(*) FROM process_reads r WHERE r.process_id = p.id AND r.user_id = ? AND r.version = p.version) AS read_me,
    (SELECT COUNT(*) FROM process_reads r WHERE r.process_id = p.id AND r.version = p.version) AS readers
    FROM processes p LEFT JOIN users u ON u.id = p.owner_id WHERE p.org_id = ? ORDER BY p.category, p.title`).all(req.user.id, req.org.id)).map(procRow) });
});

async function createProcess(req, b) {
  const count = (await db.prepare('SELECT COUNT(*) c FROM processes WHERE org_id = ?').get(req.org.id)).c;
  if (count >= 200) throw new HttpError(403, 'Limite de 200 procédures atteinte.');
  const now = nowISO();
  const id = (await db.prepare('INSERT INTO processes (org_id, title, category, steps, created_by, created_at, updated_at, owner_id, review_months, next_review) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    req.org.id, A.text(b.title, 120, { required: true, msg: 'Indiquez le titre de la procédure.' }), A.text(b.category, 60), JSON.stringify(cleanSteps(b.steps)), req.user.id, now, now,
    await A.memberOf(req, b.ownerId), reviewMonths(b.reviewMonths), reviewMonths(b.reviewMonths) ? addMonths(now.slice(0, 10), reviewMonths(b.reviewMonths)) : null)).lastInsertRowid;
  await A.logActivity(req.org.id, req.user.id, 'processes', `Procédure « ${A.text(b.title, 120)} » ajoutée`);
  return Number(id);
}
router.post('/processes', A.need('admin'), async (req, res) => res.status(201).json({ id: await createProcess(req, req.body || {}) }));

router.put('/processes/:id', A.need('admin'), async (req, res) => {
  const p = await db.prepare('SELECT * FROM processes WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!p) throw new HttpError(404, 'Procédure introuvable.');
  const b = req.body || {};
  const title = b.title === undefined ? p.title : A.text(b.title, 120, { required: true, msg: 'Le titre ne peut pas être vide.' });
  const category = b.category === undefined ? p.category : A.text(b.category, 60);
  const steps = b.steps === undefined ? p.steps : JSON.stringify(cleanSteps(b.steps));
  const content = title !== p.title || category !== p.category || steps !== p.steps;
  const months = b.reviewMonths === undefined ? Number(p.review_months || 0) : reviewMonths(b.reviewMonths);
  const owner = b.ownerId === undefined ? p.owner_id : await A.memberOf(req, b.ownerId);
  await db.transaction(async () => {
    if (content) await db.prepare('INSERT INTO process_versions (org_id, process_id, version, title, category, steps, edited_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(req.org.id, p.id, p.version, p.title, p.category, p.steps, req.user.id, nowISO());
    await db.prepare('UPDATE processes SET title = ?, category = ?, steps = ?, updated_at = ?, version = ?, owner_id = ?, review_months = ?, next_review = ? WHERE id = ?').run(title, category, steps, nowISO(), content ? Number(p.version) + 1 : p.version, owner, months,
      content || b.reviewMonths !== undefined ? (months ? addMonths(nowISO().slice(0, 10), months) : null) : p.next_review, p.id);
  })();
  if (content) {
    await W.audit(req, 'process', p.id, 'update', { title: p.title, version: p.version }, { title, version: Number(p.version) + 1 });
    for (const m of await db.prepare('SELECT user_id FROM org_members WHERE org_id = ? LIMIT 200').all(req.org.id)) if (m.user_id !== req.user.id) await W.push(req.org.id, m.user_id, 'process', `Procédure mise à jour, à relire : ${title}`, 'process:' + p.id);
  }
  res.json({ ok: true, version: content ? Number(p.version) + 1 : Number(p.version) });
});

router.delete('/processes/:id', A.need('admin'), async (req, res) => {
  const r = await db.prepare('DELETE FROM processes WHERE id = ? AND org_id = ?').run(A.id(req.params.id), req.org.id);
  if (!r.changes) throw new HttpError(404, 'Procédure introuvable.');
  res.json({ ok: true });
});

router.use(require('./structure-w3'));

module.exports = router;
module.exports.createPositions = createPositions;
module.exports.createProcess = createProcess;
