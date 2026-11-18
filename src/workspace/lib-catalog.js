'use strict';
// Bibliothèque — classification documentaire, catalogue (notices et métadonnées), vocabulaire contrôlé, import/export CSV, étiquettes.
// Une « notice » décrit une ressource : un document numérique de la bibliothèque (doc_id) ou une ressource physique (livre, norme, matériel…).
// Une notice liée à un document d'un bloc protégé n'est visible que si le bloc est ouvert (mot de passe ressaisi) : le catalogue ne révèle rien de plus que le bloc.
const { db, nowISO } = require('../db');
const A = require('./access');
const W = require('./w3');
const T = require('./lib-text');
const { HttpError, cleanText } = require('../util');

const RTYPES = ['book', 'document', 'report', 'contract', 'standard', 'digital', 'equipment'];
const RTYPE_FR = { book: 'Livre', document: 'Document', report: 'Rapport', contract: 'Contrat', standard: 'Norme', digital: 'Support numérique', equipment: 'Matériel' };
const CONDITIONS = ['new', 'good', 'fair', 'worn', 'damaged', 'lost'];
const CONDITION_FR = { new: 'Neuf', good: 'Bon', fair: 'Correct', worn: 'Usé', damaged: 'Abîmé', lost: 'Perdu' };
const STATUSES = ['available', 'loaned', 'reserved', 'lost', 'withdrawn'];
const STATUS_FR = { available: 'Disponible', loaned: 'Emprunté', reserved: 'Réservé', lost: 'Perdu', withdrawn: 'Retiré' };
const CONF = ['public', 'internal', 'restricted', 'secret'];
const CONF_FR = { public: 'Libre', internal: 'Interne', restricted: 'Restreint', secret: 'Secret' };
/** Rôle minimal pour voir une notice, selon son niveau de confidentialité. */
const CONF_MIN = { public: 'member', internal: 'member', restricted: 'manager', secret: 'admin' };
const MAX_CLASSES = 500;
const MAX_RECORDS = 20000;
const MAX_IMPORT = 2000;

// ---------- Modèles de plans de classement pour PME : [code, nom, parent, conservation (mois)] ----------
const TEMPLATES = {
  pme: { name: 'PME générale', rows: [
    ['ADM', 'Administration', null, 60], ['ADM.1', 'Courrier et correspondance', 'ADM', 36], ['ADM.2', 'Assurances', 'ADM', 120], ['ADM.3', 'Moyens généraux', 'ADM', 60],
    ['RH', 'Ressources humaines', null, 60], ['RH.1', 'Recrutement', 'RH', 24], ['RH.2', 'Contrats et paie', 'RH', 600], ['RH.3', 'Formation', 'RH', 60],
    ['FIN', 'Finance et comptabilité', null, 120], ['FIN.1', 'Factures et pièces', 'FIN', 120], ['FIN.2', 'Banque', 'FIN', 120], ['FIN.3', 'Fiscalité', 'FIN', 120],
    ['COM', 'Commercial', null, 60], ['COM.1', 'Devis et offres', 'COM', 60], ['COM.2', 'Contrats clients', 'COM', 120], ['COM.3', 'Marketing et communication', 'COM', 36],
    ['TEC', 'Technique', null, 120], ['TEC.1', 'Plans et dessins', 'TEC', 120], ['TEC.2', 'Notices et fiches techniques', 'TEC', 120], ['TEC.3', 'Maintenance', 'TEC', 60],
    ['JUR', 'Juridique', null, 120], ['JUR.1', 'Contrats', 'JUR', 120], ['JUR.2', 'Litiges', 'JUR', 120], ['JUR.3', 'Propriété intellectuelle', 'JUR', 240],
    ['QUA', 'Qualité', null, 60], ['QUA.1', 'Procédures', 'QUA', 60], ['QUA.2', 'Audits', 'QUA', 60], ['QUA.3', 'Certifications', 'QUA', 60],
  ] },
  btp: { name: 'Bâtiment et travaux publics', rows: [
    ['ADM', 'Administration', null, 60], ['RH', 'Ressources humaines', null, 60], ['FIN', 'Finance et comptabilité', null, 120],
    ['MAR', 'Marchés et appels d’offres', null, 120], ['MAR.1', 'Appels d’offres', 'MAR', 60], ['MAR.2', 'Marchés signés', 'MAR', 120],
    ['ETU', 'Études et bureau d’études', null, 120], ['ETU.1', 'Plans', 'ETU', 120], ['ETU.2', 'Notes de calcul', 'ETU', 120],
    ['CHA', 'Chantiers', null, 120], ['CHA.1', 'Comptes rendus de chantier', 'CHA', 120], ['CHA.2', 'Réceptions et garanties', 'CHA', 120],
    ['SEC', 'Sécurité et prévention', null, 60], ['QUA', 'Qualité', null, 60], ['JUR', 'Juridique et assurances', null, 120],
  ] },
  commerce: { name: 'Commerce et distribution', rows: [
    ['ADM', 'Administration', null, 60], ['RH', 'Ressources humaines', null, 60], ['FIN', 'Finance et comptabilité', null, 120],
    ['ACH', 'Achats et fournisseurs', null, 60], ['ACH.1', 'Commandes', 'ACH', 60], ['ACH.2', 'Contrats fournisseurs', 'ACH', 120],
    ['VEN', 'Ventes et clients', null, 60], ['VEN.1', 'Devis et commandes clients', 'VEN', 60], ['VEN.2', 'Garanties et retours', 'VEN', 36],
    ['STK', 'Stock et logistique', null, 36], ['MKT', 'Marketing', null, 36], ['JUR', 'Juridique', null, 120],
  ] },
  services: { name: 'Société de services', rows: [
    ['ADM', 'Administration', null, 60], ['RH', 'Ressources humaines', null, 60], ['FIN', 'Finance et comptabilité', null, 120],
    ['CLI', 'Clients', null, 60], ['CLI.1', 'Contrats et avenants', 'CLI', 120], ['CLI.2', 'Livrables', 'CLI', 60],
    ['PRJ', 'Projets', null, 60], ['PRJ.1', 'Cahiers des charges', 'PRJ', 60], ['PRJ.2', 'Comptes rendus', 'PRJ', 36],
    ['QUA', 'Qualité', null, 60], ['JUR', 'Juridique', null, 120],
  ] },
};

const cleanCode = (v) => {
  const c = cleanText(String(v || ''), 12).toUpperCase().replace(/\s+/g, '');
  if (!/^[A-Z0-9][A-Z0-9._-]{0,11}$/.test(c)) throw new HttpError(400, 'Code de classe : 1 à 12 caractères (lettres, chiffres, point, tiret).');
  return c;
};
const asBool = (v, d = true) => (v === undefined || v === null || v === '' ? d : (v === true || v === 1 || v === '1' || /^(oui|yes|true|vrai|o|y)$/i.test(String(v))));
const parseKeywords = (s) => { try { const a = JSON.parse(s || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } };
const yearOf = (d) => { const m = /^(\d{4})/.exec(String(d || '')); return m ? Number(m[1]) : null; };

module.exports = function register(router, h) {
  const { audit } = h;
  Object.assign(h.ACTIONS, {
    class_add: 'Classe ajoutée', class_edit: 'Classe modifiée', class_delete: 'Classe supprimée', class_template: 'Plan de classement appliqué',
    record_add: 'Notice ajoutée', record_edit: 'Notice modifiée', record_delete: 'Notice supprimée', record_bulk: 'Notices modifiées en masse', record_import: 'Import de notices',
    vocab_edit: 'Vocabulaire modifié',
  });

  // ---------- Réglages du catalogue et des prêts ----------
  const SETTING_KEYS = { loanDays: ['loan_days', 1, 365], maxRenewals: ['max_renewals', 0, 20], maxLoans: ['max_loans', 1, 100], finePerDay: ['fine_per_day', 0, 1000000], blockAfterDays: ['block_after_days', 0, 365], blockDays: ['block_days', 1, 365], holdDays: ['hold_days', 1, 60], remindBeforeDays: ['remind_before_days', 0, 30], remindEveryDays: ['remind_every_days', 1, 60] };
  async function catSettings(orgId) {
    await db.prepare('INSERT INTO lib_cat_settings (org_id, updated_at) VALUES (?, ?) ON CONFLICT (org_id) DO NOTHING').run(orgId, nowISO());
    const r = await db.prepare('SELECT * FROM lib_cat_settings WHERE org_id = ?').get(orgId);
    const out = { strictVocab: Boolean(Number(r.strict_vocab)) };
    for (const [k, [col]] of Object.entries(SETTING_KEYS)) out[k] = Number(r[col]);
    return out;
  }
  router.get('/catalog/settings', A.need('manager'), async (req, res) => res.json({ settings: await catSettings(req.org.id) }));
  router.put('/catalog/settings', A.need('admin'), async (req, res) => {
    const b = req.body || {}; const cur = await catSettings(req.org.id); const next = { ...cur };
    for (const [k, [, lo, hi]] of Object.entries(SETTING_KEYS)) {
      if (b[k] === undefined) continue;
      const n = Number(b[k]);
      if (!Number.isInteger(n) || n < lo || n > hi) throw new HttpError(400, 'Réglage invalide : valeur hors limites.');
      next[k] = n;
    }
    if (b.strictVocab !== undefined) next.strictVocab = Boolean(b.strictVocab);
    await db.prepare(`UPDATE lib_cat_settings SET ${Object.values(SETTING_KEYS).map(([c]) => `${c} = ?`).join(', ')}, strict_vocab = ?, updated_at = ? WHERE org_id = ?`)
      .run(...Object.keys(SETTING_KEYS).map((k) => next[k]), next.strictVocab ? 1 : 0, nowISO(), req.org.id);
    await audit(req, 'settings', null, 'catalogue et prêts');
    res.json({ settings: await catSettings(req.org.id) });
  });

  // ---------- Visibilité des notices ----------
  /** Qui voit quoi : niveau de confidentialité, puis (notice liée à un document) bloc ouvert et document visible. */
  async function visibility(req) {
    const open = await h.unlockedBlocks(req);
    const rank = A.RANK[req.member.role];
    const extra = h.visibilityHooks ? await h.visibilityHooks(req) : null;
    const canSee = (r) => {
      if (r.doc_id) {
        if (r.d_deleted) return false;
        const o = open[Number(r.d_block)];
        if (!o) return false;
        if (Number(o.b.personal) && Number(r.d_owner) !== Number(req.user.id)) return false;
      }
      if (extra && extra.override) { const v = extra.override(r); if (v !== undefined) return v; }
      return rank >= A.RANK[CONF_MIN[r.confidentiality] || 'admin'] || Number(r.created_by) === Number(req.user.id);
    };
    return { canSee, open, rank, extra };
  }
  const RECORD_SQL = 'SELECT r.*, d.block_id AS d_block, d.owner_id AS d_owner, d.deleted_at AS d_deleted, d.name AS d_name FROM lib_records r LEFT JOIN lib_docs d ON d.id = r.doc_id';
  async function visibleRecords(req, vis) {
    const rows = await db.prepare(`${RECORD_SQL} WHERE r.org_id = ? AND r.deleted_at IS NULL ORDER BY r.id`).all(req.org.id);
    return rows.filter(vis.canSee);
  }
  async function loadRecord(req, idv, vis, { deleted = false } = {}) {
    const r = await db.prepare(`${RECORD_SQL} WHERE r.id = ? AND r.org_id = ?`).get(A.id(idv, 'Notice invalide.'), req.org.id);
    if (!r || Boolean(r.deleted_at) !== deleted) throw new HttpError(404, 'Notice introuvable.');
    const v = vis || await visibility(req);
    if (!v.canSee(r)) throw new HttpError(404, 'Notice introuvable.');
    return r;
  }

  async function classMap(orgId) {
    const rows = await db.prepare('SELECT * FROM lib_classes WHERE org_id = ? ORDER BY position, code').all(orgId);
    return new Map(rows.map((c) => [Number(c.id), c]));
  }
  const classPath = (map, id) => { const out = []; let c = map.get(Number(id)); let n = 0; while (c && n++ < 12) { out.unshift(c.code); c = c.parent_id ? map.get(Number(c.parent_id)) : null; } return out.join(' › '); };
  /** Ensemble des identifiants d'une classe et de ses descendantes. */
  function subtree(map, id) {
    const out = new Set([Number(id)]); let grew = true;
    while (grew) { grew = false; for (const c of map.values()) if (c.parent_id && out.has(Number(c.parent_id)) && !out.has(Number(c.id))) { out.add(Number(c.id)); grew = true; } }
    return out;
  }
  const recordView = (r, cls, extra = {}) => ({
    id: Number(r.id), docId: r.doc_id ? Number(r.doc_id) : null, docName: r.d_name || null, type: r.rtype, title: r.title, author: r.author, publisher: r.publisher,
    pubDate: r.pub_date || null, year: r.year ? Number(r.year) : null, language: r.language, summary: r.summary, keywords: parseKeywords(r.keywords),
    callNumber: r.call_number, inventoryNo: r.inventory_no, location: r.location, condition: r.condition, status: r.status,
    classId: r.class_id ? Number(r.class_id) : null, classCode: r.class_id && cls.get(Number(r.class_id)) ? cls.get(Number(r.class_id)).code : '', classPath: r.class_id ? classPath(cls, r.class_id) : '',
    confidentiality: r.confidentiality, loanable: Boolean(Number(r.loanable)), acquiredAt: r.acquired_at || null, acquiredPrice: Number(r.acquired_price || 0),
    createdAt: r.created_at, updatedAt: r.updated_at, ...extra,
  });
  h.recordHelpers = { visibility, visibleRecords, loadRecord, classMap, classPath, subtree, recordView, RECORD_SQL, catSettings, CONF_MIN, parseKeywords };

  // ---------- Classes ----------
  async function classTree(req) {
    const vis = await visibility(req); const map = await classMap(req.org.id);
    const recs = await visibleRecords(req, vis);
    const own = new Map();
    for (const r of recs) if (r.class_id) own.set(Number(r.class_id), (own.get(Number(r.class_id)) || 0) + 1);
    const classes = [...map.values()].map((c) => {
      const ids = subtree(map, c.id);
      let total = 0; for (const i of ids) total += own.get(i) || 0;
      return { id: Number(c.id), code: c.code, name: c.name, parentId: c.parent_id ? Number(c.parent_id) : null, position: Number(c.position), retentionMonths: c.retention_months === null ? null : Number(c.retention_months), confidentiality: c.confidentiality || null, own: own.get(Number(c.id)) || 0, total, path: classPath(map, c.id) };
    });
    return { classes, unclassified: recs.filter((r) => !r.class_id).length, templates: Object.entries(TEMPLATES).map(([key, t]) => ({ key, name: t.name, count: t.rows.length })) };
  }
  router.get('/classes', async (req, res) => res.json(await classTree(req)));
  async function readClass(req, body, cur) {
    const b = body || {}; const map = await classMap(req.org.id);
    const code = b.code !== undefined || !cur ? cleanCode(b.code) : cur.code;
    const name = b.name !== undefined || !cur ? A.text(b.name, 80, { required: true, msg: 'Indiquez le nom de la classe.' }) : cur.name;
    let parentId = cur ? (cur.parent_id ? Number(cur.parent_id) : null) : null;
    if (b.parentId !== undefined) {
      parentId = b.parentId === null || b.parentId === '' ? null : A.id(b.parentId, 'Classe parente invalide.');
      if (parentId && !map.has(parentId)) throw new HttpError(400, 'Classe parente inconnue.');
      if (cur && parentId && subtree(map, cur.id).has(parentId)) throw new HttpError(400, 'Une classe ne peut pas être rangée sous elle-même.');
      let depth = 0; let p = parentId ? map.get(parentId) : null; while (p && depth++ < 12) p = p.parent_id ? map.get(Number(p.parent_id)) : null;
      if (depth >= 6) throw new HttpError(400, 'Le plan de classement ne dépasse pas 6 niveaux.');
    }
    let ret = cur ? (cur.retention_months === null ? null : Number(cur.retention_months)) : null;
    if (b.retentionMonths !== undefined) {
      if (b.retentionMonths === null || b.retentionMonths === '') ret = null;
      else { ret = Number(b.retentionMonths); if (!Number.isInteger(ret) || ret < 0 || ret > 1200) throw new HttpError(400, 'Durée de conservation : entre 0 et 1200 mois.'); }
    }
    let conf = cur ? cur.confidentiality : null;
    if (b.confidentiality !== undefined) conf = b.confidentiality === null || b.confidentiality === '' ? null : A.oneOf(b.confidentiality, CONF, undefined, 'Niveau de confidentialité inconnu.');
    const position = b.position !== undefined ? Math.max(0, Math.min(100000, Number(b.position) || 0)) : (cur ? Number(cur.position) : map.size * 10);
    return { code, name, parentId, ret, conf, position };
  }
  router.post('/classes', A.need('admin'), async (req, res) => {
    if ((await classMap(req.org.id)).size >= MAX_CLASSES) throw new HttpError(403, 'Nombre maximal de classes atteint.');
    const v = await readClass(req, req.body, null);
    if (await db.prepare('SELECT 1 FROM lib_classes WHERE org_id = ? AND code = ?').get(req.org.id, v.code)) throw new HttpError(400, 'Ce code de classe existe déjà.');
    const id = Number((await db.prepare('INSERT INTO lib_classes (org_id, code, name, parent_id, position, retention_months, confidentiality, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(req.org.id, v.code, v.name, v.parentId, v.position, v.ret, v.conf, nowISO())).lastInsertRowid);
    await audit(req, 'class_add', null, `${v.code} ${v.name}`);
    res.status(201).json({ id });
  });
  router.put('/classes/:id', A.need('admin'), async (req, res) => {
    const cur = await db.prepare('SELECT * FROM lib_classes WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
    if (!cur) throw new HttpError(404, 'Classe introuvable.');
    const v = await readClass(req, req.body, cur);
    if (v.code !== cur.code && await db.prepare('SELECT 1 FROM lib_classes WHERE org_id = ? AND code = ?').get(req.org.id, v.code)) throw new HttpError(400, 'Ce code de classe existe déjà.');
    await db.prepare('UPDATE lib_classes SET code = ?, name = ?, parent_id = ?, position = ?, retention_months = ?, confidentiality = ? WHERE id = ?').run(v.code, v.name, v.parentId, v.position, v.ret, v.conf, cur.id);
    await audit(req, 'class_edit', null, `${v.code} ${v.name}`);
    res.json({ ok: true });
  });
  router.delete('/classes/:id', A.need('admin'), async (req, res) => {
    const cur = await db.prepare('SELECT * FROM lib_classes WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
    if (!cur) throw new HttpError(404, 'Classe introuvable.');
    if (await db.prepare('SELECT 1 FROM lib_classes WHERE parent_id = ?').get(cur.id)) throw new HttpError(400, 'Cette classe contient des sous-classes : déplacez-les ou supprimez-les d’abord.');
    const n = Number((await db.prepare('SELECT COUNT(*) AS c FROM lib_records WHERE class_id = ? AND deleted_at IS NULL').get(cur.id)).c);
    const moveTo = req.query.moveTo ? A.id(req.query.moveTo, 'Classe de destination invalide.') : null;
    if (n && !moveTo) throw new HttpError(400, 'Cette classe contient des notices : indiquez la classe de destination (moveTo).');
    if (moveTo) {
      if (moveTo === Number(cur.id) || !(await db.prepare('SELECT 1 FROM lib_classes WHERE id = ? AND org_id = ?').get(moveTo, req.org.id))) throw new HttpError(400, 'Classe de destination inconnue.');
      await db.prepare('UPDATE lib_records SET class_id = ? WHERE class_id = ?').run(moveTo, cur.id);
    }
    await db.prepare('DELETE FROM lib_classes WHERE id = ?').run(cur.id);
    await audit(req, 'class_delete', null, `${cur.code} ${cur.name}`);
    res.json({ ok: true });
  });
  router.post('/classes/template', A.need('admin'), async (req, res) => {
    const t = TEMPLATES[String((req.body || {}).key || '')];
    if (!t) throw new HttpError(400, 'Modèle de plan inconnu.');
    const map = await classMap(req.org.id); const byCode = new Map([...map.values()].map((c) => [c.code, Number(c.id)]));
    let added = 0; let pos = map.size * 10;
    await db.transaction(async () => {
      for (const [code, name, parent, ret] of t.rows) {
        if (byCode.has(code)) continue;
        if (byCode.size >= MAX_CLASSES) break;
        const id = Number((await db.prepare('INSERT INTO lib_classes (org_id, code, name, parent_id, position, retention_months, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(req.org.id, code, name, parent ? byCode.get(parent) || null : null, pos += 10, ret, nowISO())).lastInsertRowid);
        byCode.set(code, id); added++;
      }
    })();
    await audit(req, 'class_template', null, `${t.name} (${added} ajoutée(s))`);
    res.json({ ok: true, added, skipped: t.rows.length - added });
  });

  // ---------- Vocabulaire contrôlé ----------
  const synList = (s) => { try { const a = JSON.parse(s || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } };
  async function thesaurus(orgId) {
    const rows = await db.prepare('SELECT * FROM lib_thesaurus WHERE org_id = ? ORDER BY LOWER(term)').all(orgId);
    const used = new Map();
    for (const r of await db.prepare('SELECT keywords FROM lib_records WHERE org_id = ? AND deleted_at IS NULL').all(orgId)) for (const k of parseKeywords(r.keywords)) used.set(T.norm(k), (used.get(T.norm(k)) || 0) + 1);
    return rows.map((t) => ({ id: Number(t.id), term: t.term, broaderId: t.broader_id ? Number(t.broader_id) : null, synonyms: synList(t.synonyms), note: t.note, uses: used.get(T.norm(t.term)) || 0 }));
  }
  /** Ramène chaque mot-clé au terme préféré du vocabulaire (synonymes reconnus) ; en mode strict, refuse les termes inconnus. */
  async function normKeywords(orgId, list, strict) {
    const terms = await thesaurus(orgId); const map = new Map();
    for (const t of terms) { map.set(T.norm(t.term), t.term); for (const s of t.synonyms) map.set(T.norm(s), t.term); }
    const out = [];
    for (const raw of Array.isArray(list) ? list : String(list || '').split(/[,;|]/)) {
      const k = cleanText(String(raw), 40).replace(/\s+/g, ' '); if (!k) continue;
      const pref = map.get(T.norm(k));
      if (!pref && strict && terms.length) throw new HttpError(400, 'Mot-clé absent du vocabulaire contrôlé : ajoutez-le au vocabulaire ou choisissez un terme existant.');
      const final = pref || k;
      if (!out.some((o) => T.norm(o) === T.norm(final))) out.push(final);
      if (out.length >= 15) break;
    }
    return out;
  }
  h.normKeywords = normKeywords; h.thesaurus = thesaurus;
  router.get('/thesaurus', async (req, res) => res.json({ terms: await thesaurus(req.org.id), strict: (await catSettings(req.org.id)).strictVocab }));
  router.get('/thesaurus/suggest', async (req, res) => {
    const q = T.norm(String((req.query || {}).q || '')); if (!q) return res.json({ terms: [] });
    const out = [];
    for (const t of await thesaurus(req.org.id)) {
      const hit = [t.term, ...t.synonyms].find((x) => T.norm(x).startsWith(q) || T.norm(x).includes(q));
      if (hit) out.push({ term: t.term, via: T.norm(hit) === T.norm(t.term) ? null : hit });
      if (out.length >= 10) break;
    }
    res.json({ terms: out });
  });
  async function readTerm(req, id) {
    const b = req.body || {};
    const term = A.text(b.term, 60, { required: true, msg: 'Indiquez le terme.' });
    const synonyms = (Array.isArray(b.synonyms) ? b.synonyms : String(b.synonyms || '').split(/[,;|]/)).map((s) => cleanText(String(s), 60)).filter(Boolean).slice(0, 20);
    let broaderId = null;
    if (b.broaderId !== undefined && b.broaderId !== null && b.broaderId !== '') {
      broaderId = A.id(b.broaderId, 'Terme générique invalide.');
      if (broaderId === id || !(await db.prepare('SELECT 1 FROM lib_thesaurus WHERE id = ? AND org_id = ?').get(broaderId, req.org.id))) throw new HttpError(400, 'Terme générique inconnu.');
    }
    const clash = await db.prepare('SELECT id FROM lib_thesaurus WHERE org_id = ? AND LOWER(term) = LOWER(?)').get(req.org.id, term);
    if (clash && Number(clash.id) !== id) throw new HttpError(400, 'Ce terme existe déjà.');
    return { term, synonyms: JSON.stringify(synonyms), broaderId, note: A.text(b.note, 200) };
  }
  router.post('/thesaurus', A.need('manager'), async (req, res) => {
    if ((await thesaurus(req.org.id)).length >= 2000) throw new HttpError(403, 'Vocabulaire plein (2000 termes).');
    const v = await readTerm(req, 0);
    const id = Number((await db.prepare('INSERT INTO lib_thesaurus (org_id, term, broader_id, synonyms, note, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(req.org.id, v.term, v.broaderId, v.synonyms, v.note, nowISO())).lastInsertRowid);
    await audit(req, 'vocab_edit', null, `+ ${v.term}`);
    res.status(201).json({ id });
  });
  router.put('/thesaurus/:id', A.need('manager'), async (req, res) => {
    const id = A.id(req.params.id); const cur = await db.prepare('SELECT * FROM lib_thesaurus WHERE id = ? AND org_id = ?').get(id, req.org.id);
    if (!cur) throw new HttpError(404, 'Terme introuvable.');
    const v = await readTerm(req, id);
    await db.prepare('UPDATE lib_thesaurus SET term = ?, broader_id = ?, synonyms = ?, note = ? WHERE id = ?').run(v.term, v.broaderId, v.synonyms, v.note, id);
    // Le terme préféré a changé de nom : les notices qui l'utilisaient suivent.
    if (T.norm(cur.term) !== T.norm(v.term)) {
      for (const r of await db.prepare('SELECT id, keywords FROM lib_records WHERE org_id = ? AND deleted_at IS NULL').all(req.org.id)) {
        const kws = parseKeywords(r.keywords);
        if (kws.some((k) => T.norm(k) === T.norm(cur.term))) await db.prepare('UPDATE lib_records SET keywords = ? WHERE id = ?').run(JSON.stringify(kws.map((k) => (T.norm(k) === T.norm(cur.term) ? v.term : k))), r.id);
      }
    }
    await audit(req, 'vocab_edit', null, `${cur.term} → ${v.term}`);
    res.json({ ok: true });
  });
  router.delete('/thesaurus/:id', A.need('manager'), async (req, res) => {
    const cur = await db.prepare('SELECT * FROM lib_thesaurus WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
    if (!cur) throw new HttpError(404, 'Terme introuvable.');
    await db.prepare('DELETE FROM lib_thesaurus WHERE id = ?').run(cur.id);
    await audit(req, 'vocab_edit', null, `− ${cur.term}`);
    res.json({ ok: true });
  });

  // ---------- Notices ----------
  async function readRecord(req, body, cur) {
    const b = body || {}; const has = (k) => b[k] !== undefined;
    const pick = (k, max, curv) => (has(k) ? cleanText(String(b[k] === null ? '' : b[k]), max) : (curv == null ? '' : curv));
    const v = {
      title: has('title') || !cur ? A.text(b.title, 200, { required: true, msg: 'Indiquez le titre de la ressource.' }) : cur.title,
      rtype: has('type') ? A.oneOf(b.type, RTYPES, undefined, 'Type de ressource inconnu.') : (cur ? cur.rtype : 'document'),
      author: pick('author', 120, cur && cur.author), publisher: pick('publisher', 120, cur && cur.publisher), language: pick('language', 20, cur && cur.language),
      summary: pick('summary', 2000, cur && cur.summary), callNumber: pick('callNumber', 60, cur && cur.call_number), location: pick('location', 120, cur && cur.location),
      pubDate: has('pubDate') ? (b.pubDate ? A.date(String(b.pubDate).length === 4 ? `${b.pubDate}-01-01` : b.pubDate) : null) : (cur ? cur.pub_date : null),
      condition: has('condition') ? A.oneOf(b.condition, CONDITIONS, undefined, 'État inconnu.') : (cur ? cur.condition : 'good'),
      confidentiality: has('confidentiality') ? A.oneOf(b.confidentiality, CONF, undefined, 'Niveau de confidentialité inconnu.') : (cur ? cur.confidentiality : null),
      loanable: has('loanable') ? asBool(b.loanable) : (cur ? Boolean(Number(cur.loanable)) : true),
      acquiredAt: has('acquiredAt') ? (b.acquiredAt ? A.date(b.acquiredAt) : null) : (cur ? cur.acquired_at : null),
      acquiredPrice: has('acquiredPrice') ? (b.acquiredPrice === '' || b.acquiredPrice === null ? 0 : A.money0(b.acquiredPrice)) : (cur ? Number(cur.acquired_price) : 0),
      inventoryNo: has('inventoryNo') ? cleanText(String(b.inventoryNo || ''), 40).replace(/\s+/g, '') : (cur ? cur.inventory_no : ''),
    };
    if (v.inventoryNo && /[^\x21-\x7e]/.test(v.inventoryNo)) throw new HttpError(400, 'Numéro d’inventaire : lettres, chiffres et signes simples seulement (pour le code-barres).');
    v.year = yearOf(v.pubDate);
    // Classe : celle indiquée, sinon (nouvelle notice) aucune ; sa confidentialité par défaut s'applique si rien n'est choisi.
    let classId = cur ? (cur.class_id ? Number(cur.class_id) : null) : null;
    if (has('classId')) {
      classId = b.classId === null || b.classId === '' ? null : A.id(b.classId, 'Classe invalide.');
      if (classId && !(await db.prepare('SELECT 1 FROM lib_classes WHERE id = ? AND org_id = ?').get(classId, req.org.id))) throw new HttpError(400, 'Classe inconnue.');
    }
    v.classId = classId;
    if (!v.confidentiality) {
      const c = classId ? await db.prepare('SELECT confidentiality FROM lib_classes WHERE id = ?').get(classId) : null;
      v.confidentiality = (c && c.confidentiality) || 'internal';
    }
    const st = await catSettings(req.org.id);
    v.keywords = has('keywords') ? await normKeywords(req.org.id, b.keywords, st.strictVocab) : (cur ? parseKeywords(cur.keywords) : []);
    // Document numérique de la bibliothèque : doit appartenir à cette organisation et être visible de la personne.
    let docId = cur ? (cur.doc_id ? Number(cur.doc_id) : null) : null;
    if (has('docId')) {
      docId = b.docId === null || b.docId === '' ? null : A.id(b.docId, 'Document invalide.');
      if (docId) await h.openDoc(req, docId, 'read');
    }
    v.docId = docId;
    return v;
  }
  async function freeInventory(orgId, id) {
    let no = `INV-${String(id).padStart(6, '0')}`; let n = 1;
    while (await db.prepare('SELECT 1 FROM lib_records WHERE org_id = ? AND inventory_no = ?').get(orgId, no)) no = `INV-${String(id).padStart(6, '0')}-${++n}`;
    return no;
  }
  async function insertRecord(req, v) {
    if (v.inventoryNo && await db.prepare('SELECT 1 FROM lib_records WHERE org_id = ? AND inventory_no = ?').get(req.org.id, v.inventoryNo)) throw new HttpError(400, 'Ce numéro d’inventaire existe déjà.');
    const now = nowISO();
    const id = Number((await db.prepare(`INSERT INTO lib_records (org_id, doc_id, rtype, title, author, publisher, pub_date, year, language, summary, keywords, call_number, inventory_no, location, condition, status, class_id, confidentiality, loanable, acquired_at, acquired_price, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'available', ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(req.org.id, v.docId, v.rtype, v.title, v.author, v.publisher, v.pubDate, v.year, v.language, v.summary, JSON.stringify(v.keywords), v.callNumber, v.inventoryNo || '', v.location, v.condition, v.classId, v.confidentiality, v.loanable ? 1 : 0, v.acquiredAt, v.acquiredPrice, req.user.id, now, now)).lastInsertRowid);
    if (!v.inventoryNo) await db.prepare('UPDATE lib_records SET inventory_no = ? WHERE id = ?').run(await freeInventory(req.org.id, id), id);
    return id;
  }
  router.post('/records', A.need('manager'), async (req, res) => {
    if (Number((await db.prepare('SELECT COUNT(*) AS c FROM lib_records WHERE org_id = ?').get(req.org.id)).c) >= MAX_RECORDS) throw new HttpError(403, 'Catalogue plein : supprimez des notices.');
    const v = await readRecord(req, req.body, null);
    const id = await insertRecord(req, v);
    await audit(req, 'record_add', null, v.title);
    res.status(201).json({ id });
  });
  router.put('/records/:id', A.need('manager'), async (req, res) => {
    const vis = await visibility(req); const cur = await loadRecord(req, req.params.id, vis);
    const v = await readRecord(req, req.body, cur);
    if (v.inventoryNo !== cur.inventory_no && await db.prepare('SELECT 1 FROM lib_records WHERE org_id = ? AND inventory_no = ? AND id <> ?').get(req.org.id, v.inventoryNo, cur.id)) throw new HttpError(400, 'Ce numéro d’inventaire existe déjà.');
    const status = (req.body || {}).status !== undefined ? A.oneOf(req.body.status, ['available', 'lost', 'withdrawn'], undefined, 'Statut modifiable : disponible, perdu ou retiré (les prêts et réservations changent le reste).') : cur.status;
    if (status !== cur.status && ['loaned', 'reserved'].includes(cur.status)) throw new HttpError(400, 'Cette ressource est empruntée ou réservée : enregistrez d’abord le retour.');
    await db.prepare(`UPDATE lib_records SET doc_id = ?, rtype = ?, title = ?, author = ?, publisher = ?, pub_date = ?, year = ?, language = ?, summary = ?, keywords = ?, call_number = ?, inventory_no = ?, location = ?, condition = ?, status = ?,
      class_id = ?, confidentiality = ?, loanable = ?, acquired_at = ?, acquired_price = ?, updated_at = ? WHERE id = ?`)
      .run(v.docId, v.rtype, v.title, v.author, v.publisher, v.pubDate, v.year, v.language, v.summary, JSON.stringify(v.keywords), v.callNumber, v.inventoryNo || cur.inventory_no, v.location, v.condition, status, v.classId, v.confidentiality, v.loanable ? 1 : 0, v.acquiredAt, v.acquiredPrice, nowISO(), cur.id);
    await audit(req, 'record_edit', null, v.title);
    res.json({ ok: true });
  });
  router.delete('/records/:id', A.need('manager'), async (req, res) => {
    const cur = await loadRecord(req, req.params.id);
    if (['loaned', 'reserved'].includes(cur.status)) throw new HttpError(400, 'Cette ressource est empruntée ou réservée : enregistrez d’abord le retour.');
    if (h.recordLocked && await h.recordLocked(cur)) throw new HttpError(403, h.recordLocked.msg || 'Cette notice est sous scellé ou gel légal : elle ne se supprime pas.');
    await db.prepare('UPDATE lib_records SET deleted_at = ?, updated_at = ? WHERE id = ?').run(nowISO(), nowISO(), cur.id);
    await audit(req, 'record_delete', null, cur.title);
    res.json({ ok: true });
  });
  /** Modification en masse : classe, emplacement, confidentialité (500 notices au plus). */
  router.post('/records/bulk', A.need('manager'), async (req, res) => {
    const b = req.body || {}; const ids = [...new Set((Array.isArray(b.ids) ? b.ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    if (!ids.length || ids.length > 500) throw new HttpError(400, 'Sélectionnez entre 1 et 500 notices.');
    const sets = []; const args = [];
    if (b.classId !== undefined) {
      const c = b.classId === null || b.classId === '' ? null : A.id(b.classId, 'Classe invalide.');
      if (c && !(await db.prepare('SELECT 1 FROM lib_classes WHERE id = ? AND org_id = ?').get(c, req.org.id))) throw new HttpError(400, 'Classe inconnue.');
      sets.push('class_id = ?'); args.push(c);
    }
    if (b.location !== undefined) { sets.push('location = ?'); args.push(cleanText(String(b.location || ''), 120)); }
    if (b.confidentiality !== undefined) { sets.push('confidentiality = ?'); args.push(A.oneOf(b.confidentiality, CONF, undefined, 'Niveau de confidentialité inconnu.')); }
    if (!sets.length) throw new HttpError(400, 'Indiquez ce qu’il faut changer (classe, emplacement ou confidentialité).');
    const vis = await visibility(req); const rows = (await db.prepare(`${RECORD_SQL} WHERE r.org_id = ? AND r.deleted_at IS NULL AND r.id IN (${ids.map(() => '?').join(',')})`).all(req.org.id, ...ids)).filter(vis.canSee);
    if (!rows.length) throw new HttpError(404, 'Aucune notice trouvée.');
    await db.prepare(`UPDATE lib_records SET ${sets.join(', ')}, updated_at = ? WHERE id IN (${rows.map(() => '?').join(',')})`).run(...args, nowISO(), ...rows.map((r) => r.id));
    await audit(req, 'record_bulk', null, `${rows.length} notice(s)`);
    res.json({ ok: true, updated: rows.length });
  });
  /** Catalogue des documents numériques d'un bloc ouvert : une notice par document, avec la classe indiquée. */
  router.post('/records/from-docs', A.need('manager'), async (req, res) => {
    const b = req.body || {}; const ids = [...new Set((Array.isArray(b.docIds) ? b.docIds : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 200);
    if (!ids.length) throw new HttpError(400, 'Sélectionnez des documents.');
    const classId = b.classId ? A.id(b.classId, 'Classe invalide.') : null;
    if (classId && !(await db.prepare('SELECT 1 FROM lib_classes WHERE id = ? AND org_id = ?').get(classId, req.org.id))) throw new HttpError(400, 'Classe inconnue.');
    let created = 0; let existing = 0;
    for (const did of ids) {
      const { d } = await h.openDoc(req, did, 'read');
      if (await db.prepare('SELECT 1 FROM lib_records WHERE org_id = ? AND doc_id = ? AND deleted_at IS NULL').get(req.org.id, d.id)) { existing++; continue; }
      const v = await readRecord(req, { title: d.name.replace(/\.[A-Za-z0-9]{1,8}$/, ''), type: 'document', docId: d.id, classId, loanable: false, keywords: (() => { try { return JSON.parse(d.tags || '[]'); } catch { return []; } })() }, null);
      v.keywords = (() => { try { return JSON.parse(d.tags || '[]').slice(0, 15); } catch { return []; } })();
      await insertRecord(req, v); created++;
    }
    await audit(req, 'record_add', null, `${created} document(s) catalogué(s)`);
    res.json({ ok: true, created, existing });
  });

  // ---------- Catalogue consultable : recherche simple, facettes, tri, pagination ----------
  const decorate = async (req, rows, cls) => {
    const ids = rows.map((r) => Number(r.id)); const loans = new Map(); const queue = new Map();
    if (ids.length) {
      const ph = ids.map(() => '?').join(',');
      for (const l of await db.prepare(`SELECT record_id, user_id, due_at FROM lib_loans WHERE state = 'active' AND record_id IN (${ph})`).all(...ids)) loans.set(Number(l.record_id), l);
      for (const q of await db.prepare(`SELECT record_id, COUNT(*) AS c FROM lib_reservations WHERE state IN ('waiting','ready') AND record_id IN (${ph}) GROUP BY record_id`).all(...ids)) queue.set(Number(q.record_id), Number(q.c));
    }
    const names = await h.namesOf([...loans.values()].map((l) => l.user_id));
    const now = nowISO();
    return rows.map((r) => {
      const l = loans.get(Number(r.id));
      const mine = l && Number(l.user_id) === Number(req.user.id);
      return recordView(r, cls, { loan: l ? { due: l.due_at, overdue: l.due_at < now, mine, by: A.can(req, 'manager') || mine ? names[Number(l.user_id)] || '' : '' } : null, queue: queue.get(Number(r.id)) || 0 });
    });
  };
  const FACETS = { type: (r) => r.rtype, class: (r) => (r.class_id ? String(r.class_id) : ''), year: (r) => (r.year ? String(r.year) : ''), language: (r) => r.language || '', status: (r) => r.status, conf: (r) => r.confidentiality };
  router.get('/catalog', async (req, res) => {
    const q = req.query || {}; const vis = await visibility(req); const cls = await classMap(req.org.id);
    const all = await visibleRecords(req, vis);
    const tokens = T.words(String(q.q || ''), { stop: false }); const thes = tokens.length ? await thesaurus(req.org.id) : [];
    // Chaque mot peut aussi être trouvé par un synonyme du vocabulaire contrôlé.
    const alt = tokens.map((t) => { const set = new Set([t]); for (const e of thes) { const forms = [e.term, ...e.synonyms].map(T.norm); if (forms.includes(t)) for (const f of forms) set.add(f); } return [...set]; });
    const hay = new Map(all.map((r) => [Number(r.id), T.norm([r.title, r.author, r.publisher, r.summary, parseKeywords(r.keywords).join(' '), r.call_number, r.inventory_no, r.location, r.d_name || ''].join(' '))]));
    const classSet = q.class ? subtree(cls, A.id(q.class, 'Classe invalide.')) : null;
    const flt = {
      type: (r) => !q.type || r.rtype === q.type, class: (r) => !classSet || (r.class_id && classSet.has(Number(r.class_id))),
      year: (r) => !q.year || String(r.year || '') === String(q.year), language: (r) => !q.language || (r.language || '') === q.language,
      status: (r) => !q.status || r.status === q.status, conf: (r) => !q.conf || r.confidentiality === q.conf,
    };
    const textOk = (r) => !tokens.length || alt.every((forms) => forms.some((f) => hay.get(Number(r.id)).includes(f)));
    const passes = (r, skip) => textOk(r) && Object.entries(flt).every(([k, f]) => k === skip || f(r));
    const facets = {};
    for (const key of Object.keys(FACETS)) {
      const counts = new Map();
      for (const r of all) if (passes(r, key)) { const v = FACETS[key](r); counts.set(v, (counts.get(v) || 0) + 1); }
      facets[key] = [...counts.entries()].filter(([v]) => v !== '').map(([value, count]) => ({ value, count, label: key === 'class' ? (cls.get(Number(value)) ? `${cls.get(Number(value)).code} ${cls.get(Number(value)).name}` : value) : key === 'type' ? RTYPE_FR[value] : key === 'status' ? STATUS_FR[value] : key === 'conf' ? CONF_FR[value] : value }))
        .sort((a, b) => (key === 'year' ? b.value - a.value : b.count - a.count || String(a.label).localeCompare(String(b.label), 'fr')));
    }
    let hits = all.filter((r) => passes(r, null));
    const sort = String(q.sort || 'title');
    const cmp = { title: (a, b) => a.title.localeCompare(b.title, 'fr'), recent: (a, b) => (b.updated_at > a.updated_at ? 1 : -1), year: (a, b) => Number(b.year || 0) - Number(a.year || 0), call: (a, b) => a.call_number.localeCompare(b.call_number, 'fr') }[sort] || ((a, b) => a.title.localeCompare(b.title, 'fr'));
    hits = hits.sort(cmp);
    if (q.available === '1') hits = hits.filter((r) => r.status === 'available' && Number(r.loanable));
    const page = Math.max(1, Number(q.page) || 1); const size = Math.min(100, Math.max(5, Number(q.size) || 25));
    res.json({ total: hits.length, page, size, records: await decorate(req, hits.slice((page - 1) * size, page * size), cls), facets });
  });
  router.get('/records/:id', async (req, res) => {
    const vis = await visibility(req); const r = await loadRecord(req, req.params.id, vis); const cls = await classMap(req.org.id);
    const [view] = await decorate(req, [r], cls);
    const out = { record: view, perms: { edit: A.can(req, 'manager') } };
    if (h.recordDetails) Object.assign(out, await h.recordDetails(req, r, vis));
    res.json(out);
  });
  /** Résolution d'un code lu (code-barres ou QR) : numéro d'inventaire ou cote. */
  router.get('/scan', async (req, res) => {
    const code = cleanText(String((req.query || {}).code || ''), 60); if (!code) throw new HttpError(400, 'Code vide.');
    const vis = await visibility(req); const cls = await classMap(req.org.id);
    const rows = (await db.prepare(`${RECORD_SQL} WHERE r.org_id = ? AND r.deleted_at IS NULL AND (LOWER(r.inventory_no) = LOWER(?) OR LOWER(r.call_number) = LOWER(?)) LIMIT 5`).all(req.org.id, code, code)).filter(vis.canSee);
    if (!rows.length) throw new HttpError(404, 'Aucune ressource ne porte ce code.');
    const [view] = await decorate(req, [rows[0]], cls);
    res.json({ record: view });
  });

  // ---------- Import / export CSV ----------
  const CSV_HEAD = ['type', 'titre', 'auteur', 'editeur', 'date', 'langue', 'resume', 'mots_cles', 'cote', 'inventaire', 'emplacement', 'etat', 'classe', 'confidentialite', 'pretable', 'acquisition', 'prix'];
  const byLabel = (map) => Object.fromEntries(Object.entries(map).flatMap(([k, v]) => [[T.norm(k), k], [T.norm(v), k]]));
  const TYPE_IN = byLabel(RTYPE_FR); const COND_IN = byLabel(CONDITION_FR); const CONF_IN = byLabel(CONF_FR);
  router.get('/catalog/export.csv', A.need('manager'), async (req, res) => {
    const vis = await visibility(req); const cls = await classMap(req.org.id); const rows = await visibleRecords(req, vis);
    await audit(req, 'download', null, `export du catalogue (${rows.length})`);
    W.sendCsv(res, 'catalogue-bibliotheque.csv', CSV_HEAD, rows.map((r) => [RTYPE_FR[r.rtype], r.title, r.author, r.publisher, r.pub_date || '', r.language, r.summary, parseKeywords(r.keywords).join('|'), r.call_number, r.inventory_no, r.location, CONDITION_FR[r.condition], r.class_id && cls.get(Number(r.class_id)) ? cls.get(Number(r.class_id)).code : '', CONF_FR[r.confidentiality], Number(r.loanable) ? 'oui' : 'non', r.acquired_at || '', Number(r.acquired_price) || '']));
  });
  router.post('/catalog/import', A.need('manager'), async (req, res) => {
    const b = req.body || {}; const csv = typeof b.csv === 'string' ? b.csv : '';
    if (!csv.trim()) throw new HttpError(400, 'Collez le contenu du fichier CSV.');
    if (csv.length > 2 * 1024 * 1024) throw new HttpError(413, 'Fichier CSV trop gros (2 Mo au plus).');
    const rows = W.parseCsv(csv); if (rows.length < 2) throw new HttpError(400, 'Le fichier ne contient aucune ligne de données.');
    const head = rows[0].map((c) => T.norm(c).replace(/ /g, '_')); const col = (name) => head.indexOf(name);
    if (col('titre') < 0) throw new HttpError(400, 'La colonne « titre » est obligatoire (voir le modèle d’export).');
    if (rows.length - 1 > MAX_IMPORT) throw new HttpError(400, 'Trop de lignes : importez 2000 lignes au plus à la fois.');
    const cls = await classMap(req.org.id); const byCode = new Map([...cls.values()].map((c) => [c.code, Number(c.id)]));
    const dry = Boolean(b.dryRun); const errors = []; let created = 0; let updated = 0;
    for (let i = 1; i < rows.length; i++) {
      const get = (n) => (col(n) >= 0 ? String(rows[i][col(n)] || '').trim() : undefined);
      try {
        const inv = get('inventaire') || '';
        const obj = { title: get('titre') };
        const set = (k, v) => { if (v !== undefined) obj[k] = v; };
        const t = get('type'); if (t) { const code = TYPE_IN[T.norm(t)]; if (!code) throw new HttpError(400, 'Type inconnu.'); obj.type = code; }
        set('author', get('auteur')); set('publisher', get('editeur')); set('language', get('langue')); set('summary', get('resume')); set('callNumber', get('cote')); set('location', get('emplacement'));
        const d = get('date'); if (d !== undefined) obj.pubDate = d || null;
        const kw = get('mots_cles'); if (kw !== undefined) obj.keywords = kw.split(/[|;]/);
        const e = get('etat'); if (e) { const code = COND_IN[T.norm(e)]; if (!code) throw new HttpError(400, 'État inconnu.'); obj.condition = code; }
        const c = get('confidentialite'); if (c) { const code = CONF_IN[T.norm(c)]; if (!code) throw new HttpError(400, 'Confidentialité inconnue.'); obj.confidentiality = code; }
        const cl = get('classe'); if (cl) { if (!byCode.has(cl.toUpperCase())) throw new HttpError(400, 'Classe inconnue.'); obj.classId = byCode.get(cl.toUpperCase()); }
        const p = get('pretable'); if (p !== undefined && p !== '') obj.loanable = asBool(p);
        const acq = get('acquisition'); if (acq !== undefined) obj.acquiredAt = acq || null;
        const pr = get('prix'); if (pr !== undefined) obj.acquiredPrice = pr === '' ? 0 : pr;
        if (inv) obj.inventoryNo = inv;
        const cur = inv ? await db.prepare(`${RECORD_SQL} WHERE r.org_id = ? AND r.inventory_no = ? AND r.deleted_at IS NULL`).get(req.org.id, inv) : null;
        const v = await readRecord(req, obj, cur);
        if (dry) { cur ? updated++ : created++; continue; }
        if (cur) {
          await db.prepare(`UPDATE lib_records SET rtype = ?, title = ?, author = ?, publisher = ?, pub_date = ?, year = ?, language = ?, summary = ?, keywords = ?, call_number = ?, location = ?, condition = ?, class_id = ?, confidentiality = ?, loanable = ?, acquired_at = ?, acquired_price = ?, updated_at = ? WHERE id = ?`)
            .run(v.rtype, v.title, v.author, v.publisher, v.pubDate, v.year, v.language, v.summary, JSON.stringify(v.keywords), v.callNumber, v.location, v.condition, v.classId, v.confidentiality, v.loanable ? 1 : 0, v.acquiredAt, v.acquiredPrice, nowISO(), cur.id);
          updated++;
        } else { await insertRecord(req, v); created++; }
      } catch (e) { errors.push({ line: i + 1, message: e instanceof HttpError ? e.message : 'Ligne illisible.' }); if (errors.length >= 50) break; }
    }
    if (!dry && (created || updated)) await audit(req, 'record_import', null, `${created} créée(s), ${updated} mise(s) à jour`);
    res.json({ ok: true, dryRun: dry, created, updated, errors });
  });

  // ---------- Étiquettes imprimables : code-barres Code 128 et QR du numéro d'inventaire ----------
  router.get('/labels', A.need('manager'), async (req, res) => {
    const ids = String((req.query || {}).ids || '').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 60);
    if (!ids.length) throw new HttpError(400, 'Indiquez les ressources à étiqueter.');
    const QR = require('qrcode'); const vis = await visibility(req);
    const rows = (await db.prepare(`${RECORD_SQL} WHERE r.org_id = ? AND r.deleted_at IS NULL AND r.id IN (${ids.map(() => '?').join(',')})`).all(req.org.id, ...ids)).filter(vis.canSee);
    const labels = [];
    for (const r of rows) {
      let bars = ''; try { bars = T.code128Svg(r.inventory_no); } catch { bars = ''; }
      labels.push({ id: Number(r.id), title: r.title, callNumber: r.call_number, inventoryNo: r.inventory_no, location: r.location, barcodeSvg: bars, qrSvg: await QR.toString(r.inventory_no, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }) });
    }
    res.json({ labels });
  });

  // ---------- Statistiques du catalogue (tableau de bord) ----------
  router.get('/catalog/stats', async (req, res) => {
    const vis = await visibility(req); const cls = await classMap(req.org.id); const rows = await visibleRecords(req, vis);
    const count = (fn) => { const m = new Map(); for (const r of rows) { const k = fn(r); m.set(k, (m.get(k) || 0) + 1); } return m; };
    const top = (c) => { let x = c; let n = 0; while (x && x.parent_id && n++ < 12) x = cls.get(Number(x.parent_id)); return x; };
    const byClass = count((r) => { const c = r.class_id ? cls.get(Number(r.class_id)) : null; const t0 = c ? top(c) : null; return t0 ? `${t0.code} ${t0.name}` : ''; });
    const arr = (m, label) => [...m.entries()].map(([value, n]) => ({ value, label: label ? label(value) : value, count: n })).sort((a, b) => b.count - a.count);
    const st = await catSettings(req.org.id);
    res.json({
      total: rows.length, unclassified: rows.filter((r) => !r.class_id).length, withDocument: rows.filter((r) => r.doc_id).length, physical: rows.filter((r) => !r.doc_id).length,
      byType: arr(count((r) => r.rtype), (v) => RTYPE_FR[v]), byStatus: arr(count((r) => r.status), (v) => STATUS_FR[v]), byClass: arr(byClass, (v) => v || 'Sans classe'),
      byYear: [...count((r) => (r.year ? String(r.year) : '')).entries()].filter(([y]) => y).map(([value, n]) => ({ value, count: n })).sort((a, b) => a.value.localeCompare(b.value)),
      conditions: arr(count((r) => r.condition), (v) => CONDITION_FR[v]),
      loans: h.loanSummary ? await h.loanSummary(req.org.id, st) : null,
    });
  });

  // ---------- Constantes pour le site ----------
  router.get('/catalog/meta', async (req, res) => res.json({
    types: RTYPES.map((k) => ({ value: k, label: RTYPE_FR[k] })), conditions: CONDITIONS.map((k) => ({ value: k, label: CONDITION_FR[k] })),
    statuses: STATUSES.map((k) => ({ value: k, label: STATUS_FR[k] })), confidentialities: CONF.map((k) => ({ value: k, label: CONF_FR[k], minRole: CONF_MIN[k] })),
    csvColumns: CSV_HEAD,
  }));
};
module.exports.constants = { RTYPES, CONDITIONS, STATUSES, CONF, CONF_MIN, TEMPLATES };
