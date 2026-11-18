'use strict';
// Bibliothèque — archivage et conservation : durées par classe, cycle de vie (actif → semi-actif → archivé → à détruire), échéancier,
// validation avant destruction, certificats de destruction chaînés par empreinte, mise sous scellé (empreinte d'intégrité), gel légal (legal hold).
//
// Règles :
//  - La durée de conservation d'une notice est la sienne si elle en a une, sinon celle de sa classe (ou de la classe parente la plus proche).
//  - À l'échéance : sort « destruction » → la notice passe « à détruire » et attend une validation ; sort « conservation définitive » → elle passe « archivée » pour de bon.
//  - Rien n'est détruit sans validation d'un responsable puis destruction par un administrateur (une autre personne, sauf le propriétaire) ; une notice sous gel légal n'est jamais détruite.
//  - Une notice sous scellé ne se modifie plus (ni sa fiche, ni son document) : on peut vérifier à tout moment que rien n'a changé.
//  - Chaque destruction produit un certificat dont l'empreinte dépend du précédent : une altération ou un retrait est détecté.
const crypto = require('crypto');
const { db, nowISO } = require('../db');
const A = require('./access');
const W = require('./w3');
const X = require('./legal-extra');
const { HttpError, cleanText } = require('../util');

const LIFECYCLES = ['active', 'semi', 'archived', 'destroy_due', 'destroyed'];
const sha = (x) => crypto.createHash('sha256').update(x).digest('hex');
const canon = (o) => JSON.stringify(Object.keys(o).sort().reduce((a, k) => { a[k] = o[k]; return a; }, {}));
const today = () => nowISO().slice(0, 10);
const addMonths = (date, n) => { const d = new Date(`${String(date).slice(0, 10)}T00:00:00Z`); const day = d.getUTCDate(); d.setUTCMonth(d.getUTCMonth() + Number(n)); if (d.getUTCDate() < day) d.setUTCDate(0); return d.toISOString().slice(0, 10); };

module.exports = function register(router, h) {
  const { audit } = h;
  const R = () => h.recordHelpers;
  Object.assign(h.ACTIONS, {
    archive_transition: 'Cycle de vie modifié', archive_validate: 'Destruction validée', archive_unvalidate: 'Validation retirée', archive_destroy: 'Destruction avec certificat', retention_edit: 'Conservation modifiée',
    seal: 'Mise sous scellé', unseal: 'Scellé levé', hold_add: 'Gel légal posé', hold_edit: 'Gel légal modifié', hold_release: 'Gel légal levé',
  });

  // ---------- Conservation d'une notice ----------
  async function classesOf(orgId) { return new Map((await db.prepare('SELECT id, parent_id, code, retention_months, final_fate FROM lib_classes WHERE org_id = ?').all(orgId)).map((c) => [Number(c.id), c])); }
  /** { months, until, start, fate } d'une notice. */
  function retentionOf(r, classes) {
    let months = r.ret_months === null || r.ret_months === undefined ? null : Number(r.ret_months);
    let c = r.class_id ? classes.get(Number(r.class_id)) : null; const fate = c ? c.final_fate || 'destroy' : 'destroy'; let n = 0;
    if (months === null) while (c && n++ < 12) { if (c.retention_months !== null && c.retention_months !== undefined) { months = Number(c.retention_months); break; } c = c.parent_id ? classes.get(Number(c.parent_id)) : null; }
    const start = r.ret_start || String(r.created_at).slice(0, 10);
    return { months, start, until: months === null ? null : addMonths(start, months), fate };
  }
  async function heldSet(orgId) { return new Set((await db.prepare('SELECT DISTINCT i.record_id FROM lib_hold_items i JOIN lib_holds h ON h.id = i.hold_id WHERE h.org_id = ? AND h.released_at IS NULL').all(orgId)).map((x) => Number(x.record_id))); }
  const heldNames = async (orgId, recId) => (await db.prepare('SELECT h.id, h.name FROM lib_hold_items i JOIN lib_holds h ON h.id = i.hold_id WHERE h.org_id = ? AND h.released_at IS NULL AND i.record_id = ?').all(orgId, recId)).map((x) => ({ id: Number(x.id), name: x.name }));

  // ---------- Notices figées ----------
  h.recordFrozen = async (rec) => {
    if (rec.sealed_hash) { const e = new HttpError(403, 'Cette notice est sous scellé : elle ne se modifie plus.'); e.errorCode = 'record_sealed'; throw e; }
    if ((await heldNames(rec.org_id, rec.id)).length) { const e = new HttpError(403, 'Cette notice est sous gel légal : elle ne se modifie ni ne se supprime.'); e.errorCode = 'record_held'; throw e; }
  };
  h.checkDocFrozen = async (req, d) => {
    for (const r of await db.prepare('SELECT * FROM lib_records WHERE org_id = ? AND doc_id = ? AND deleted_at IS NULL').all(req.org.id, d.id)) await h.recordFrozen(r);
  };

  // ---------- Cycle de vie : balayage ----------
  async function sweep(orgId) {
    const st = await R().catSettings(orgId); const classes = await classesOf(orgId); const held = await heldSet(orgId);
    const rows = await db.prepare("SELECT * FROM lib_records WHERE org_id = ? AND deleted_at IS NULL AND lifecycle <> 'destroyed'").all(orgId);
    const t = today(); const now = nowISO(); let changed = 0; let newlyDue = 0;
    for (const r of rows) {
      const ret = retentionOf(r, classes);
      let target = r.lifecycle;
      if (!held.has(Number(r.id))) {
        if (ret.until && t >= ret.until) target = ret.fate === 'keep' ? 'archived' : 'destroy_due';
        else if (['active', 'semi'].includes(r.lifecycle)) target = ret.months !== null && t >= addMonths(ret.start, st.activeMonths) ? 'semi' : 'active';
      }
      if (ret.until !== (r.ret_until || null) || target !== r.lifecycle) {
        await db.prepare('UPDATE lib_records SET ret_until = ?, lifecycle = ?, lifecycle_at = ? WHERE id = ?').run(ret.until, target, target !== r.lifecycle ? now : r.lifecycle_at, r.id);
        if (target !== r.lifecycle) { changed++; if (target === 'destroy_due') newlyDue++; }
      }
    }
    if (newlyDue) await W.pushRole(orgId, 'admin', 'library', `Bibliothèque : ${newlyDue} ressource(s) arrivent au terme de leur durée de conservation. Une validation est nécessaire avant destruction.`, 'libarchive');
    return { changed, newlyDue };
  }
  h.archiveMaintenance = async () => {
    const out = { changed: 0, newlyDue: 0 };
    for (const o of await db.prepare('SELECT DISTINCT org_id FROM lib_records').all()) { const r = await sweep(Number(o.org_id)); out.changed += r.changed; out.newlyDue += r.newlyDue; }
    return out;
  };
  router.post('/archive/sweep', A.need('admin'), async (req, res) => res.json({ ok: true, ...(await sweep(req.org.id)) }));

  // ---------- Vue d'ensemble et échéancier ----------
  const LIFE_FR = { active: 'Actif', semi: 'Semi-actif', archived: 'Archivé', destroy_due: 'À détruire', destroyed: 'Détruit' };
  async function archiveRows(req) {
    const vis = await R().visibility(req); const rows = await R().visibleRecords(req, vis);
    return { rows: rows.filter((r) => r.lifecycle !== 'destroyed'), vis };
  }
  router.get('/archive/overview', A.need('manager'), async (req, res) => {
    await sweep(req.org.id);
    const { rows } = await archiveRows(req); const classes = await classesOf(req.org.id); const held = await heldSet(req.org.id); const t = today();
    const fresh = await db.prepare('SELECT id, ret_until, lifecycle, destroy_ok_by FROM lib_records WHERE org_id = ? AND deleted_at IS NULL').all(req.org.id);
    const ids = new Set(rows.map((r) => Number(r.id))); const mine = fresh.filter((r) => ids.has(Number(r.id)));
    const count = (k) => mine.filter((r) => r.lifecycle === k).length;
    const byMonth = new Map();
    for (const r of mine) if (r.ret_until && r.lifecycle !== 'destroyed') { const m = r.ret_until < t ? 'past' : r.ret_until.slice(0, 7); byMonth.set(m, (byMonth.get(m) || 0) + 1); }
    const horizon = []; const d0 = new Date(`${t.slice(0, 7)}-01T00:00:00Z`);
    for (let i = 0; i < 24; i++) { const d = new Date(d0); d.setUTCMonth(d0.getUTCMonth() + i); const k = d.toISOString().slice(0, 7); horizon.push({ month: k, count: byMonth.get(k) || 0 }); }
    const certs = Number((await db.prepare('SELECT COUNT(*) AS c FROM lib_destructions WHERE org_id = ?').get(req.org.id)).c);
    res.json({
      lifecycle: LIFECYCLES.filter((k) => k !== 'destroyed').map((k) => ({ value: k, label: LIFE_FR[k], count: count(k) })),
      overdue: byMonth.get('past') || 0, horizon, validated: mine.filter((r) => r.lifecycle === 'destroy_due' && r.destroy_ok_by).length, held: mine.filter((r) => held.has(Number(r.id))).length,
      sealed: rows.filter((r) => r.sealed_hash).length, certificates: certs, withoutRetention: rows.filter((r) => retentionOf(r, classes).months === null).length,
    });
  });
  router.get('/archive/schedule', A.need('manager'), async (req, res) => {
    await sweep(req.org.id);
    const { rows } = await archiveRows(req); const cls = await R().classMap(req.org.id); const held = await heldSet(req.org.id);
    const fresh = new Map((await db.prepare('SELECT id, ret_until, lifecycle, destroy_ok_by, sealed_hash FROM lib_records WHERE org_id = ?').all(req.org.id)).map((r) => [Number(r.id), r]));
    const q = req.query || {}; const only = String(q.state || '');
    let list = rows.map((r) => { const f = fresh.get(Number(r.id)); return { id: Number(r.id), title: r.title, inventoryNo: r.inventory_no, classCode: r.class_id && cls.get(Number(r.class_id)) ? cls.get(Number(r.class_id)).code : '', lifecycle: f.lifecycle, retUntil: f.ret_until, validated: Boolean(f.destroy_ok_by), held: held.has(Number(r.id)), sealed: Boolean(f.sealed_hash), type: r.rtype }; });
    if (only) list = list.filter((r) => r.lifecycle === only);
    list = list.filter((r) => r.retUntil || only).sort((a, b) => String(a.retUntil || '9').localeCompare(String(b.retUntil || '9')) || a.id - b.id);
    res.json({ records: list.slice(0, 500) });
  });
  router.post('/records/:id/retention', A.need('manager'), async (req, res) => {
    const r = await R().loadRecord(req, req.params.id); const b = req.body || {};
    await h.recordFrozen(r);
    let start = r.ret_start; let months = r.ret_months;
    if (b.retStart !== undefined) start = b.retStart ? A.date(b.retStart) : null;
    if (b.retMonths !== undefined) { if (b.retMonths === null || b.retMonths === '') months = null; else { months = Number(b.retMonths); if (!Number.isInteger(months) || months < 0 || months > 1200) throw new HttpError(400, 'Durée de conservation : entre 0 et 1200 mois.'); } }
    await db.prepare('UPDATE lib_records SET ret_start = ?, ret_months = ?, updated_at = ? WHERE id = ?').run(start, months, nowISO(), r.id);
    await sweep(req.org.id);
    await audit(req, 'retention_edit', null, r.title);
    res.json({ ok: true });
  });
  router.post('/archive/transition', A.need('manager'), async (req, res) => {
    const b = req.body || {}; const to = A.oneOf(b.to, ['active', 'semi', 'archived'], undefined, 'Étape inconnue (actif, semi-actif ou archivé).');
    const ids = [...new Set((Array.isArray(b.ids) ? b.ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    if (!ids.length || ids.length > 500) throw new HttpError(400, 'Sélectionnez entre 1 et 500 notices.');
    const vis = await R().visibility(req); const held = await heldSet(req.org.id); let n = 0;
    for (const r of (await db.prepare(`${R().RECORD_SQL} WHERE r.org_id = ? AND r.deleted_at IS NULL AND r.id IN (${ids.map(() => '?').join(',')})`).all(req.org.id, ...ids)).filter(vis.canSee)) {
      if (held.has(Number(r.id)) || ['destroy_due', 'destroyed'].includes(r.lifecycle) || r.lifecycle === to) continue;
      await db.prepare('UPDATE lib_records SET lifecycle = ?, lifecycle_at = ? WHERE id = ?').run(to, nowISO(), r.id); n++;
    }
    await audit(req, 'archive_transition', null, `${n} notice(s) → ${to}`);
    res.json({ ok: true, updated: n });
  });

  // ---------- Validation puis destruction, avec certificat ----------
  const pickIds = (b) => [...new Set((Array.isArray((b || {}).ids) ? b.ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 200);
  router.post('/archive/validate', A.need('manager'), async (req, res) => {
    const ids = pickIds(req.body); if (!ids.length) throw new HttpError(400, 'Sélectionnez des notices à valider.');
    const vis = await R().visibility(req); const held = await heldSet(req.org.id); let n = 0;
    for (const r of (await db.prepare(`${R().RECORD_SQL} WHERE r.org_id = ? AND r.deleted_at IS NULL AND r.id IN (${ids.map(() => '?').join(',')})`).all(req.org.id, ...ids)).filter(vis.canSee)) {
      if (r.lifecycle !== 'destroy_due' || held.has(Number(r.id))) continue;
      await db.prepare('UPDATE lib_records SET destroy_ok_by = ?, destroy_ok_at = ? WHERE id = ?').run(req.user.id, nowISO(), r.id); n++;
    }
    if (!n) throw new HttpError(400, 'Aucune notice à valider : elles doivent être « à détruire » et sans gel légal.');
    await audit(req, 'archive_validate', null, `${n} notice(s)`);
    res.json({ ok: true, validated: n });
  });
  router.post('/archive/unvalidate', A.need('manager'), async (req, res) => {
    const ids = pickIds(req.body); if (!ids.length) throw new HttpError(400, 'Sélectionnez des notices.');
    await db.prepare(`UPDATE lib_records SET destroy_ok_by = NULL, destroy_ok_at = NULL WHERE org_id = ? AND id IN (${ids.map(() => '?').join(',')})`).run(req.org.id, ...ids);
    await audit(req, 'archive_unvalidate', null, `${ids.length} notice(s)`);
    res.json({ ok: true });
  });
  async function docSha(rec) {
    if (!rec.doc_id) return null;
    const v = await db.prepare('SELECT v.data FROM lib_versions v JOIN lib_docs d ON d.id = v.doc_id AND v.n = d.version WHERE d.id = ?').get(rec.doc_id);
    const buf = v ? X.unseal(v.data) : null;
    return buf ? sha(buf) : null;
  }
  router.post('/archive/destroy', A.need('admin'), async (req, res) => {
    const b = req.body || {}; const ids = pickIds(b);
    if (!ids.length) throw new HttpError(400, 'Sélectionnez des notices à détruire.');
    if (b.confirm !== true) throw new HttpError(400, 'Confirmez la destruction : elle est définitive.');
    const method = cleanText(String(b.method || 'Effacement définitif'), 80);
    const vis = await R().visibility(req); const held = await heldSet(req.org.id); const classes = await classesOf(req.org.id); const cls = await R().classMap(req.org.id);
    const rows = (await db.prepare(`${R().RECORD_SQL} WHERE r.org_id = ? AND r.deleted_at IS NULL AND r.id IN (${ids.map(() => '?').join(',')})`).all(req.org.id, ...ids)).filter(vis.canSee);
    if (!rows.length) throw new HttpError(404, 'Aucune notice trouvée.');
    const t = today(); const certs = [];
    for (const r of rows) {
      if (held.has(Number(r.id))) throw new HttpError(403, 'Une des notices est sous gel légal : elle ne peut pas être détruite.');
      if (r.lifecycle !== 'destroy_due' || !r.destroy_ok_by) throw new HttpError(400, 'Chaque notice doit être « à détruire » et validée par un responsable avant destruction.');
      const ret = retentionOf(r, classes); if (!ret.until || ret.until > t) throw new HttpError(400, 'La durée de conservation n’est pas écoulée pour une des notices.');
      if (Number(r.destroy_ok_by) === Number(req.user.id) && req.member.role !== 'owner') throw new HttpError(403, 'La destruction doit être faite par une autre personne que celle qui l’a validée (sauf le propriétaire).');
    }
    await db.transaction(async () => {
      for (const r of rows) {
        const year = nowISO().slice(0, 4);
        const n = Number((await db.prepare('SELECT COUNT(*) AS c FROM lib_destructions WHERE org_id = ? AND cert_no LIKE ?').get(req.org.id, `DES-${year}-%`)).c) + 1;
        const certNo = `DES-${year}-${String(n).padStart(4, '0')}`;
        const ret = retentionOf(r, classes); const now = nowISO();
        const validator = (await h.namesOf([r.destroy_ok_by]))[Number(r.destroy_ok_by)] || '';
        const snap = { certNo, recordId: Number(r.id), title: r.title, type: r.rtype, author: r.author, inventoryNo: r.inventory_no, callNumber: r.call_number, classCode: r.class_id && cls.get(Number(r.class_id)) ? cls.get(Number(r.class_id)).code : '', createdAt: r.created_at, retentionUntil: ret.until, documentName: r.d_name || null, documentSha256: await docSha(r), sealedHash: r.sealed_hash || null, validatedBy: validator, validatedAt: r.destroy_ok_at, destroyedBy: req.user.name || '', destroyedAt: now, method };
        const last = await db.prepare('SELECT hash FROM lib_destructions WHERE org_id = ? ORDER BY id DESC LIMIT 1').get(req.org.id);
        const prev = last ? last.hash : '';
        const hash = sha(prev + canon(snap));
        const cid = Number((await db.prepare('INSERT INTO lib_destructions (org_id, cert_no, record_id, title, snapshot, method, validated_by, destroyed_by, destroyed_at, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(req.org.id, certNo, r.id, r.title, JSON.stringify(snap), method, r.destroy_ok_by, req.user.id, now, prev, hash)).lastInsertRowid);
        // Le document numérique disparaît pour de bon (versions comprises), sauf s'il est encore rattaché à une autre notice.
        if (r.doc_id && !(await db.prepare('SELECT 1 FROM lib_records WHERE doc_id = ? AND id <> ? AND deleted_at IS NULL').get(r.doc_id, r.id))) await db.prepare('DELETE FROM lib_docs WHERE id = ? AND org_id = ?').run(r.doc_id, req.org.id);
        await db.prepare("UPDATE lib_records SET deleted_at = ?, lifecycle = 'destroyed', lifecycle_at = ?, doc_id = NULL, status = 'withdrawn', updated_at = ? WHERE id = ?").run(now, now, now, r.id);
        certs.push({ id: cid, certNo, title: r.title });
      }
    })();
    await audit(req, 'archive_destroy', null, `${certs.length} destruction(s) : ${certs.map((c) => c.certNo).join(', ')}`);
    res.json({ ok: true, certificates: certs });
  });
  router.get('/archive/certificates', A.need('manager'), async (req, res) => {
    const rows = await db.prepare('SELECT id, cert_no, title, method, destroyed_at, validated_by, destroyed_by FROM lib_destructions WHERE org_id = ? ORDER BY id DESC LIMIT 500').all(req.org.id);
    const names = await h.namesOf(rows.flatMap((x) => [x.validated_by, x.destroyed_by]));
    res.json({ certificates: rows.map((x) => ({ id: Number(x.id), certNo: x.cert_no, title: x.title, method: x.method, destroyedAt: x.destroyed_at, validatedBy: names[Number(x.validated_by)] || '', destroyedBy: names[Number(x.destroyed_by)] || '' })) });
  });
  /** Contrôle de la chaîne : chaque empreinte doit se recalculer à partir de la précédente et du contenu du certificat. */
  async function verifyChain(orgId) {
    const rows = await db.prepare('SELECT * FROM lib_destructions WHERE org_id = ? ORDER BY id').all(orgId);
    let prev = '';
    for (const x of rows) {
      let snap; try { snap = JSON.parse(x.snapshot); } catch { return { ok: false, brokenAt: x.cert_no, count: rows.length }; }
      if (x.prev_hash !== prev || sha(prev + canon(snap)) !== x.hash) return { ok: false, brokenAt: x.cert_no, count: rows.length };
      prev = x.hash;
    }
    return { ok: true, brokenAt: null, count: rows.length };
  }
  router.get('/archive/certificates/verify', A.need('manager'), async (req, res) => res.json(await verifyChain(req.org.id)));
  router.get('/archive/certificates/:id', A.need('manager'), async (req, res) => {
    const x = await db.prepare('SELECT * FROM lib_destructions WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
    if (!x) throw new HttpError(404, 'Certificat introuvable.');
    res.json({ certificate: { id: Number(x.id), certNo: x.cert_no, ...JSON.parse(x.snapshot), hash: x.hash, prevHash: x.prev_hash }, chain: await verifyChain(req.org.id) });
  });

  // ---------- Scellé ----------
  async function sealPayload(rec) {
    return { title: rec.title, author: rec.author, type: rec.rtype, inventoryNo: rec.inventory_no, callNumber: rec.call_number, pubDate: rec.pub_date || '', classId: rec.class_id ? Number(rec.class_id) : null, documentSha256: await docSha(rec), documentVersion: rec.doc_id ? Number((await db.prepare('SELECT version FROM lib_docs WHERE id = ?').get(rec.doc_id) || {}).version || 0) : null };
  }
  router.post('/records/:id/seal', A.need('admin'), async (req, res) => {
    const r = await R().loadRecord(req, req.params.id);
    if (r.sealed_hash) throw new HttpError(400, 'Cette notice est déjà sous scellé.');
    const hash = sha(canon(await sealPayload(r))); const now = nowISO();
    await db.prepare('UPDATE lib_records SET sealed_hash = ?, sealed_at = ?, sealed_by = ? WHERE id = ?').run(hash, now, req.user.id, r.id);
    await audit(req, 'seal', null, r.title);
    res.json({ ok: true, hash, sealedAt: now });
  });
  router.get('/records/:id/verify', A.need('manager'), async (req, res) => {
    const r = await R().loadRecord(req, req.params.id);
    if (!r.sealed_hash) throw new HttpError(400, 'Cette notice n’est pas sous scellé.');
    const actual = sha(canon(await sealPayload(r)));
    res.json({ intact: actual === r.sealed_hash, sealedAt: r.sealed_at, sealedBy: (await h.namesOf([r.sealed_by]))[Number(r.sealed_by)] || '', expected: r.sealed_hash, actual });
  });
  router.delete('/records/:id/seal', A.need('owner'), async (req, res) => {
    const r = await R().loadRecord(req, req.params.id);
    if (!r.sealed_hash) throw new HttpError(400, 'Cette notice n’est pas sous scellé.');
    await db.prepare('UPDATE lib_records SET sealed_hash = NULL, sealed_at = NULL, sealed_by = NULL WHERE id = ?').run(r.id);
    await audit(req, 'unseal', null, r.title);
    res.json({ ok: true });
  });

  // ---------- Gel légal ----------
  async function addToHold(req, hold, body) {
    const vis = await R().visibility(req); const classes = await R().classMap(req.org.id);
    let ids = [...new Set((Array.isArray((body || {}).recordIds) ? body.recordIds : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    if (body && body.classId) { const set = R().subtree(classes, A.id(body.classId, 'Classe invalide.')); ids = ids.concat((await db.prepare('SELECT id, class_id FROM lib_records WHERE org_id = ? AND deleted_at IS NULL AND class_id IS NOT NULL').all(req.org.id)).filter((x) => set.has(Number(x.class_id))).map((x) => Number(x.id))); }
    ids = [...new Set(ids)].slice(0, 2000); let n = 0;
    if (!ids.length) return 0;
    for (const r of (await db.prepare(`${R().RECORD_SQL} WHERE r.org_id = ? AND r.deleted_at IS NULL AND r.id IN (${ids.map(() => '?').join(',')})`).all(req.org.id, ...ids)).filter(vis.canSee)) {
      const x = await db.prepare('INSERT INTO lib_hold_items (hold_id, record_id, org_id) VALUES (?, ?, ?) ON CONFLICT DO NOTHING').run(hold.id, r.id, req.org.id);
      if (x.changes) n++;
    }
    return n;
  }
  router.get('/archive/holds', A.need('manager'), async (req, res) => {
    const rows = await db.prepare('SELECT h.*, (SELECT COUNT(*) FROM lib_hold_items i WHERE i.hold_id = h.id) AS n FROM lib_holds h WHERE h.org_id = ? ORDER BY h.id DESC').all(req.org.id);
    const names = await h.namesOf(rows.map((x) => x.created_by));
    res.json({ holds: rows.map((x) => ({ id: Number(x.id), name: x.name, reason: x.reason, items: Number(x.n), createdBy: names[Number(x.created_by)] || '', createdAt: x.created_at, releasedAt: x.released_at, active: !x.released_at })) });
  });
  router.post('/archive/holds', A.need('admin'), async (req, res) => {
    const b = req.body || {}; const name = A.text(b.name, 120, { required: true, msg: 'Indiquez le nom du gel légal.' });
    const id = Number((await db.prepare('INSERT INTO lib_holds (org_id, name, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?)').run(req.org.id, name, A.text(b.reason, 300), req.user.id, nowISO())).lastInsertRowid);
    const n = await addToHold(req, { id }, b);
    await audit(req, 'hold_add', null, `${name} (${n} notice(s))`);
    res.status(201).json({ id, items: n });
  });
  router.post('/archive/holds/:id/items', A.need('admin'), async (req, res) => {
    const hold = await db.prepare('SELECT * FROM lib_holds WHERE id = ? AND org_id = ? AND released_at IS NULL').get(A.id(req.params.id), req.org.id);
    if (!hold) throw new HttpError(404, 'Gel légal introuvable.');
    const n = await addToHold(req, hold, req.body);
    await audit(req, 'hold_edit', null, `${hold.name} (+${n})`);
    res.json({ ok: true, added: n });
  });
  router.post('/archive/holds/:id/release', A.need('admin'), async (req, res) => {
    const hold = await db.prepare('SELECT * FROM lib_holds WHERE id = ? AND org_id = ? AND released_at IS NULL').get(A.id(req.params.id), req.org.id);
    if (!hold) throw new HttpError(404, 'Gel légal introuvable.');
    await db.prepare('UPDATE lib_holds SET released_at = ?, released_by = ? WHERE id = ?').run(nowISO(), req.user.id, hold.id);
    await audit(req, 'hold_release', null, hold.name);
    res.json({ ok: true });
  });

  // ---------- Fiche d'une notice : conservation, scellé, gel ----------
  const prev = h.recordDetails;
  h.recordDetails = async (req, r, vis) => {
    const out = prev ? await prev(req, r, vis) : {};
    const classes = await classesOf(req.org.id); const ret = retentionOf(r, classes);
    out.archive = { lifecycle: r.lifecycle || 'active', lifecycleLabel: LIFE_FR[r.lifecycle || 'active'], months: ret.months, start: ret.start, until: ret.until, fate: ret.fate, overridden: r.ret_months !== null && r.ret_months !== undefined, validated: Boolean(r.destroy_ok_by), sealed: r.sealed_hash ? { at: r.sealed_at, by: (await h.namesOf([r.sealed_by]))[Number(r.sealed_by)] || '' } : null, holds: await heldNames(req.org.id, r.id) };
    return out;
  };
  h.lifecycleLabels = LIFE_FR;
};
module.exports.addMonths = addMonths;
