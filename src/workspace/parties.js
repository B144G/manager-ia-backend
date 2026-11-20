'use strict';
// Clients et fournisseurs typés : simple, temporaire (avec date de fin), permanent, haut de gamme (VIP).
// Les fiches vivent dans les tables EXISTANTES `customers` (Clients et ventes, Commercial) et `suppliers` (Achats, Trésorerie) : la migration 141
// ajoute seulement des colonnes (type, fin de validité, GPS, étiquettes, statut, conditions propres). Rien n'est dupliqué ; les liens avec les autres
// modules sont des lectures (factures, commandes, contacts, conditions de trésorerie) et un bouton « appliquer les conditions » qui écrit dans les champs
// déjà utilisés par la facturation (remise par défaut) et les achats (délai de paiement).
// Monté sur /orgs/:orgId/parties.
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const G = require('./tms-geo-lib');
const { HttpError } = require('../util');

const router = express.Router({ mergeParams: true });
const mgr = A.need('manager');
const TYPES = ['simple', 'temporary', 'permanent', 'vip'];
const STATUSES = ['active', 'inactive', 'archived'];
const KINDS = { customers: { table: 'customers', kind: 'customer', min: 'member' }, suppliers: { table: 'suppliers', kind: 'supplier', min: 'manager' } };
const today = () => nowISO().slice(0, 10);

/** Résout :kind (customers | suppliers) et applique le rôle minimal (les fournisseurs sont réservés aux responsables, comme dans Achats). */
function kindOf(req, res, next) {
  const k = KINDS[req.params.kind];
  if (!k) throw new HttpError(404, 'Page introuvable.');
  if (!A.can(req, k.min)) throw new HttpError(403, "Votre rôle ne permet pas cette action.");
  req.pk = k; next();
}
const tags = (v) => [...new Set(String(Array.isArray(v) ? v.join(',') : v || '').split(/[,;]/).map((t) => t.trim().toLowerCase().slice(0, 30)).filter(Boolean))].slice(0, 12).join(',');
const optNum = (v, min, max, msg) => { if (v === undefined) return undefined; if (v === null || v === '') return null; const n = Number(String(v).replace(/\s/g, '').replace(',', '.')); if (!Number.isFinite(n) || n < min || n > max) throw new HttpError(400, msg); return n; };
const optInt = (v, min, max, msg) => { const n = optNum(v, min, max, msg); return n === undefined || n === null ? n : Math.round(n); };
const email = (v) => { const e = A.text(v, 150); if (e && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) throw new HttpError(400, 'Adresse e-mail invalide.'); return e; };
const lat = (v) => { const n = Number(v); if (v === null || v === '' || !Number.isFinite(n) || n < -90 || n > 90) throw new HttpError(400, 'Latitude invalide (entre -90 et 90).'); return n; };
const lng = (v) => { const n = Number(v); if (v === null || v === '' || !Number.isFinite(n) || n < -180 || n > 180) throw new HttpError(400, 'Longitude invalide (entre -180 et 180).'); return n; };

// ---------- Conditions propres à chaque type ----------
async function typeTerms(orgId, kind) {
  const rows = await db.prepare('SELECT * FROM pty_terms WHERE org_id = ? AND kind = ?').all(orgId, kind);
  const out = {};
  for (const t of TYPES) { const r = rows.find((x) => x.party_type === t); out[t] = { discountPct: r && r.discount_pct !== null ? Number(r.discount_pct) : null, paymentDays: r && r.payment_days !== null ? Number(r.payment_days) : null, deliveryDays: r && r.delivery_days !== null ? Number(r.delivery_days) : null, creditLimit: r && r.credit_limit !== null ? Number(r.credit_limit) : null, note: r ? r.note : '' }; }
  return out;
}
router.get('/types', async (req, res) => {
  const counts = {};
  for (const [name, k] of Object.entries(KINDS)) {
    if (!A.can(req, k.min)) continue;
    const rows = await db.prepare(`SELECT party_type, COUNT(*) AS n FROM ${k.table} WHERE org_id = ? GROUP BY party_type`).all(req.org.id);
    counts[name] = Object.fromEntries(TYPES.map((t) => [t, Number((rows.find((r) => r.party_type === t) || {}).n || 0)]));
  }
  res.json({ types: TYPES, statuses: STATUSES, terms: { customers: await typeTerms(req.org.id, 'customer'), suppliers: A.can(req, 'manager') ? await typeTerms(req.org.id, 'supplier') : undefined }, counts });
});
router.put('/terms/:kind/:type', mgr, async (req, res) => {
  const k = KINDS[req.params.kind]; if (!k) throw new HttpError(404, 'Page introuvable.');
  const type = A.oneOf(req.params.type, TYPES, undefined, 'Type inconnu.'); const b = req.body || {};
  const v = { d: optNum(b.discountPct, 0, 100, 'Remise invalide (0 à 100 %).'), p: optInt(b.paymentDays, 0, 365, 'Délai de paiement : entre 0 et 365 jours.'), l: optInt(b.deliveryDays, 0, 365, 'Délai de livraison : entre 0 et 365 jours.'), c: optInt(b.creditLimit, 0, 1e12, 'Plafond invalide.') };
  await db.prepare(`INSERT INTO pty_terms (org_id, kind, party_type, discount_pct, payment_days, delivery_days, credit_limit, note, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (org_id, kind, party_type) DO UPDATE SET discount_pct = EXCLUDED.discount_pct, payment_days = EXCLUDED.payment_days, delivery_days = EXCLUDED.delivery_days, credit_limit = EXCLUDED.credit_limit, note = EXCLUDED.note, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`)
    .run(req.org.id, k.kind, type, v.d ?? null, v.p ?? null, v.l ?? null, v.c ?? null, A.text(b.note, 300), req.user.id, nowISO());
  await A.logActivity(req.org.id, req.user.id, 'crm', `Conditions « ${type} » des ${k.kind === 'customer' ? 'clients' : 'fournisseurs'} modifiées`);
  res.json({ ok: true, terms: await typeTerms(req.org.id, k.kind) });
});

// ---------- Vue d'une fiche ----------
/** Conditions effectives : celles de la fiche, sinon celles du type, sinon (anciens champs) la remise ou le délai déjà utilisés par la facturation et les achats. */
function effective(row, kind, tt) {
  const t = tt[row.party_type] || {};
  const pick = (own, typed, legacy) => (own !== null && own !== undefined ? { value: Number(own), from: 'own' } : typed !== null && typed !== undefined ? { value: Number(typed), from: 'type' } : legacy !== null && legacy !== undefined && Number(legacy) > 0 ? { value: Number(legacy), from: 'legacy' } : { value: null, from: null });
  return {
    discountPct: pick(row.pty_discount, t.discountPct, row.default_discount),
    paymentDays: pick(kind === 'supplier' ? row.payment_days : row.pty_pay_days, t.paymentDays, null), // fournisseur : le délai de paiement d'Achats est LE champ de la fiche
    deliveryDays: pick(row.pty_delivery_days, t.deliveryDays, null),
    creditLimit: pick(row.pty_credit_limit, t.creditLimit, null),
  };
}
function view(row, kind, tt, extra = {}) {
  const cust = kind === 'customer';
  const expired = row.party_type === 'temporary' && row.valid_until && row.valid_until < today();
  const hasGps = row.lat !== null && row.lat !== undefined && row.lng !== null && row.lng !== undefined;
  return {
    id: Number(row.id), kind, name: row.name, type: row.party_type, validUntil: row.valid_until || null, expired: Boolean(expired), status: !cust && Number(row.blocked) ? 'blocked' : row.party_status,
    contactPerson: cust ? null : row.contact_person, phone: row.phone, email: row.email, address: row.address, city: row.city || '', taxId: cust ? row.niu : row.tax_id, category: cust ? (row.sector || '') : (row.category || ''),
    notes: row.notes, tags: row.tags ? row.tags.split(',') : [], blocked: cust ? undefined : Boolean(Number(row.blocked)), branchId: cust ? (row.branch_id ? Number(row.branch_id) : null) : undefined,
    location: hasGps ? { lat: Number(row.lat), lng: Number(row.lng), source: row.geo_source || '', at: row.geo_at || null } : null,
    own: { discountPct: row.pty_discount === null ? null : Number(row.pty_discount), paymentDays: (cust ? row.pty_pay_days : row.payment_days) === null ? null : Number(cust ? row.pty_pay_days : row.payment_days), deliveryDays: row.pty_delivery_days === null ? null : Number(row.pty_delivery_days), creditLimit: row.pty_credit_limit === null ? null : Number(row.pty_credit_limit) },
    terms: effective(row, kind, tt), typeChangedAt: row.type_changed_at || null, createdAt: row.created_at, ...extra,
  };
}
async function rowOf(req, id) {
  const r = await db.prepare(`SELECT * FROM ${req.pk.table} WHERE id = ? AND org_id = ?`).get(A.id(id), req.org.id);
  if (!r || (req.pk.kind === 'customer' && !A.visible(req, r))) throw new HttpError(404, `${req.pk.kind === 'customer' ? 'Client' : 'Fournisseur'} introuvable.`);
  return r;
}

// ---------- Liste, recherche, filtres ----------
router.get('/:kind', kindOf, async (req, res) => {
  const k = req.pk; const cust = k.kind === 'customer'; const q = req.query;
  const w = ['x.org_id = ?']; const a = [req.org.id];
  if (cust) { const sc = A.scope(req, 'x.branch_id'); if (sc.sql) { w.push(sc.sql.replace(/^ AND /, '')); a.push(...sc.args); } }
  if (q.type) { w.push('x.party_type = ?'); a.push(A.oneOf(String(q.type), TYPES, undefined, 'Type inconnu.')); }
  if (q.status) {
    if (q.status === 'blocked' && !cust) w.push('x.blocked = 1');
    else { w.push('x.party_status = ?'); a.push(A.oneOf(String(q.status), STATUSES, undefined, 'Statut inconnu.')); }
  } else w.push("x.party_status <> 'archived'");
  if (q.expired === '1') { w.push("x.party_type = 'temporary' AND x.valid_until < ?"); a.push(today()); }
  if (q.located === '1') w.push('x.lat IS NOT NULL AND x.lng IS NOT NULL');
  if (q.tag) { w.push("(',' || x.tags || ',') LIKE ? ESCAPE '\\'"); a.push(`%,${String(q.tag).toLowerCase().replace(/[\\%_]/g, '\\$&')},%`); }
  if (q.q) {
    const t = `%${String(q.q).toLowerCase().slice(0, 80).replace(/[\\%_]/g, '\\$&')}%`;
    const cols = cust ? ['x.name', 'x.phone', 'x.email', 'x.address', 'x.city', 'x.tags', 'x.notes'] : ['x.name', 'x.contact_person', 'x.phone', 'x.email', 'x.address', 'x.city', 'x.tags', 'x.category'];
    w.push(`(${cols.map((c) => `LOWER(${c}) LIKE ? ESCAPE '\\'`).join(' OR ')})`); a.push(...cols.map(() => t));
  }
  const lim = Math.min(Math.max(Number(q.limit) || 200, 1), 500); const off = Math.max(Number(q.offset) || 0, 0);
  const total = Number((await db.prepare(`SELECT COUNT(*) AS n FROM ${k.table} x WHERE ${w.join(' AND ')}`).get(...a)).n);
  const rows = await db.prepare(`SELECT x.* FROM ${k.table} x WHERE ${w.join(' AND ')} ORDER BY LOWER(x.name) LIMIT ? OFFSET ?`).all(...a, lim, off);
  const tt = await typeTerms(req.org.id, k.kind);
  res.json({ total, items: rows.map((r) => view(r, k.kind, tt)) });
});

// ---------- Export / import CSV ----------
const CSV_COLS = [['name', 'Nom'], ['type', 'Type'], ['validUntil', 'Fin de validité'], ['status', 'Statut'], ['contactPerson', 'Contact'], ['phone', 'Téléphone'], ['email', 'E-mail'], ['address', 'Adresse'], ['city', 'Ville'], ['taxId', 'N° contribuable'], ['category', 'Catégorie'], ['tags', 'Étiquettes'], ['lat', 'Latitude'], ['lng', 'Longitude'], ['discountPct', 'Remise %'], ['paymentDays', 'Délai de paiement (j)'], ['deliveryDays', 'Délai de livraison (j)'], ['creditLimit', 'Plafond'], ['notes', 'Notes']];
router.get('/:kind/export.csv', kindOf, mgr, async (req, res) => {
  const k = req.pk; const tt = await typeTerms(req.org.id, k.kind);
  const rows = await db.prepare(`SELECT * FROM ${k.table} WHERE org_id = ? ORDER BY LOWER(name)`).all(req.org.id);
  const out = [CSV_COLS.map((c) => c[1])];
  for (const r of rows) {
    if (k.kind === 'customer' && !A.visible(req, r)) continue;
    const v = view(r, k.kind, tt);
    out.push([v.name, v.type, v.validUntil || '', v.status, v.contactPerson || '', v.phone, v.email, v.address, v.city, v.taxId, v.category, v.tags.join(','), v.location ? v.location.lat : '', v.location ? v.location.lng : '', v.own.discountPct ?? '', v.own.paymentDays ?? '', v.own.deliveryDays ?? '', v.own.creditLimit ?? '', v.notes]);
  }
  await A.logActivity(req.org.id, req.user.id, 'crm', `Export CSV des ${k.kind === 'customer' ? 'clients' : 'fournisseurs'}`);
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${k.table}.csv"`, 'Cache-Control': 'private, no-store' }).send(G.toCsv(out));
});
const HEAD = { nom: 'name', name: 'name', type: 'type', 'fin de validité': 'validUntil', 'fin de validite': 'validUntil', validuntil: 'validUntil', statut: 'status', status: 'status', contact: 'contactPerson', 'téléphone': 'phone', telephone: 'phone', phone: 'phone', 'e-mail': 'email', email: 'email', adresse: 'address', address: 'address', ville: 'city', city: 'city', 'n° contribuable': 'taxId', niu: 'taxId', taxid: 'taxId', 'catégorie': 'category', categorie: 'category', category: 'category', 'étiquettes': 'tags', etiquettes: 'tags', tags: 'tags', latitude: 'lat', lat: 'lat', longitude: 'lng', lng: 'lng', 'remise %': 'discountPct', remise: 'discountPct', 'délai de paiement (j)': 'paymentDays', 'delai de paiement (j)': 'paymentDays', 'délai de livraison (j)': 'deliveryDays', 'delai de livraison (j)': 'deliveryDays', plafond: 'creditLimit', notes: 'notes' };
const TYPE_ALIAS = { simple: 'simple', temporaire: 'temporary', temporary: 'temporary', permanent: 'permanent', vip: 'vip', 'haut de gamme': 'vip', 'haut-de-gamme': 'vip' };
const STATUS_ALIAS = { actif: 'active', active: 'active', inactif: 'inactive', inactive: 'inactive', archivé: 'archived', archive: 'archived', archived: 'archived' };

/** Lit une ligne du CSV en champs validés ; renvoie { data } ou { error } (la ligne est refusée avec son numéro, les autres passent). */
function readRow(cells, cols, kind) {
  const g = (k) => { const i = cols.indexOf(k); return i < 0 ? undefined : String(cells[i] === undefined ? '' : cells[i]).trim(); };
  try {
    const name = A.text(g('name'), 100, { required: true, msg: 'Nom manquant.' });
    const d = { name };
    if (g('type')) { const t = TYPE_ALIAS[g('type').toLowerCase()]; if (!t) throw new HttpError(400, `Type inconnu « ${g('type')} » (simple, temporaire, permanent, vip).`); d.type = t; }
    if (g('validUntil')) d.validUntil = A.date(g('validUntil'));
    if (d.type === 'temporary' && !d.validUntil) throw new HttpError(400, 'Un client ou fournisseur temporaire a besoin d\'une date de fin.');
    if (g('status')) { const s = STATUS_ALIAS[g('status').toLowerCase()]; if (!s) throw new HttpError(400, `Statut inconnu « ${g('status')} ».`); d.status = s; }
    for (const [k, max] of [['contactPerson', 100], ['phone', 40], ['address', 300], ['city', 80], ['taxId', 40], ['category', 60], ['notes', 800]]) if (g(k) !== undefined && g(k) !== '') d[k] = A.text(g(k), max);
    if (kind === 'customer') delete d.contactPerson;
    if (g('email')) d.email = email(g('email'));
    if (g('tags')) d.tags = tags(g('tags'));
    if (g('lat') || g('lng')) { d.lat = lat(String(g('lat')).replace(',', '.')); d.lng = lng(String(g('lng')).replace(',', '.')); }
    if (g('discountPct')) d.discountPct = optNum(g('discountPct'), 0, 100, 'Remise invalide (0 à 100 %).');
    if (g('paymentDays')) d.paymentDays = optInt(g('paymentDays'), 0, 365, 'Délai de paiement : entre 0 et 365 jours.');
    if (g('deliveryDays')) d.deliveryDays = optInt(g('deliveryDays'), 0, 365, 'Délai de livraison : entre 0 et 365 jours.');
    if (g('creditLimit')) d.creditLimit = optInt(g('creditLimit'), 0, 1e12, 'Plafond invalide.');
    return { data: d };
  } catch (e) { if (e instanceof HttpError) return { error: e.message }; throw e; }
}
router.post('/:kind/import', kindOf, mgr, async (req, res) => {
  const k = req.pk; const b = req.body || {};
  const text = String(b.csv || '');
  if (!text.trim()) throw new HttpError(400, 'Collez ou chargez un fichier CSV.');
  if (text.length > 2e6) throw new HttpError(413, 'Fichier trop volumineux (2 Mo au plus).');
  const rows = G.parseCsv(text);
  if (rows.length < 2) throw new HttpError(400, 'Le fichier doit contenir une ligne d\'en-têtes puis au moins une ligne de données.');
  if (rows.length > 2001) throw new HttpError(400, '2 000 lignes au plus par import.');
  const cols = rows[0].map((h) => HEAD[String(h).trim().toLowerCase()] || null);
  if (!cols.includes('name')) throw new HttpError(400, 'Colonne « Nom » introuvable dans la première ligne.');
  const dry = b.dryRun === true; const report = { created: 0, updated: 0, skipped: 0, errors: [] };
  const seen = new Set();
  for (const [i, cells] of rows.slice(1).entries()) {
    const line = i + 2; const r = readRow(cells, cols, k.kind);
    if (r.error) { report.errors.push({ line, message: r.error }); report.skipped++; continue; }
    const d = r.data; const key = d.name.toLowerCase();
    if (seen.has(key)) { report.errors.push({ line, message: `Doublon dans le fichier : « ${d.name} ».` }); report.skipped++; continue; }
    seen.add(key);
    const ex = await db.prepare(`SELECT * FROM ${k.table} WHERE org_id = ? AND LOWER(name) = LOWER(?)`).get(req.org.id, d.name);
    if (ex) { if (!dry) await saveParty(req, k, ex, d, { log: true }); report.updated++; } else { if (!dry) await createParty(req, k, d); report.created++; }
  }
  if (!dry) await A.logActivity(req.org.id, req.user.id, 'crm', `Import CSV des ${k.kind === 'customer' ? 'clients' : 'fournisseurs'} : ${report.created} créé(s), ${report.updated} mis à jour`);
  res.status(dry ? 200 : 201).json({ dryRun: dry, ...report });
});

// ---------- Création, modification ----------
function columns(k, d, cur) {
  const cust = k.kind === 'customer'; const has = (x) => d[x] !== undefined; const o = cur || {};
  const c = {};
  if (has('name')) c.name = d.name;
  if (has('phone')) c.phone = d.phone; if (has('email')) c.email = d.email; if (has('address')) c.address = d.address; if (has('city')) c.city = d.city;
  if (has('notes')) c.notes = d.notes; if (has('tags')) c.tags = d.tags;
  if (has('taxId')) c[cust ? 'niu' : 'tax_id'] = d.taxId; if (has('category')) c[cust ? 'sector' : 'category'] = d.category;
  if (!cust && has('contactPerson')) c.contact_person = d.contactPerson;
  if (has('status')) { c.party_status = d.status; }
  if (has('discountPct')) c.pty_discount = d.discountPct; if (has('paymentDays')) c[cust ? 'pty_pay_days' : 'payment_days'] = d.paymentDays; if (has('deliveryDays')) c.pty_delivery_days = d.deliveryDays; if (has('creditLimit')) c.pty_credit_limit = d.creditLimit;
  if (has('lat') && has('lng') && d.lat !== null) { c.lat = d.lat; c.lng = d.lng; c.geo_source = d.geoSource || 'manual'; c.geo_at = nowISO(); }
  void o; return c;
}
function readBody(req, k, b, cur) {
  const cust = k.kind === 'customer'; const d = {}; const has = (x) => b[x] !== undefined;
  if (has('name') || !cur) d.name = A.text(b.name, 100, { required: true, msg: cust ? 'Indiquez le nom du client.' : 'Indiquez le nom du fournisseur.' });
  for (const [x, max] of [['phone', 40], ['address', 300], ['city', 80], ['notes', 800], ['taxId', 40], ['category', 60]]) if (has(x)) d[x] = A.text(b[x], max);
  if (!cust && has('contactPerson')) d.contactPerson = A.text(b.contactPerson, 100);
  if (has('email')) d.email = email(b.email);
  if (has('tags')) d.tags = tags(b.tags);
  if (has('status')) { if (!cust && b.status === 'blocked') d.blocked = 1; else { d.status = A.oneOf(b.status, STATUSES, undefined, 'Statut inconnu (actif, inactif ou archivé).'); if (!cust) d.blocked = 0; } }
  if (has('discountPct')) d.discountPct = optNum(b.discountPct, 0, 100, 'Remise invalide (0 à 100 %).');
  if (has('paymentDays')) d.paymentDays = optInt(b.paymentDays, 0, 365, 'Délai de paiement : entre 0 et 365 jours.');
  if (has('deliveryDays')) d.deliveryDays = optInt(b.deliveryDays, 0, 365, 'Délai de livraison : entre 0 et 365 jours.');
  if (has('creditLimit')) d.creditLimit = optInt(b.creditLimit, 0, 1e12, 'Plafond invalide.');
  if (b.lat !== undefined || b.lng !== undefined) {
    if ((b.lat === null || b.lat === '') && (b.lng === null || b.lng === '')) { d.lat = null; d.lng = null; } else { d.lat = lat(b.lat); d.lng = lng(b.lng); d.geoSource = A.oneOf(b.geoSource, ['address', 'pin', 'gps', 'manual'], 'manual', 'Origine de la position inconnue.'); }
  }
  void req; return d;
}
async function dupName(req, k, name, selfId) {
  const dup = await db.prepare(`SELECT id FROM ${k.table} WHERE org_id = ? AND LOWER(name) = LOWER(?) AND id <> ?`).get(req.org.id, name, selfId || 0);
  if (dup) throw new HttpError(409, k.kind === 'customer' ? 'Un client de ce nom existe déjà.' : 'Un fournisseur de ce nom existe déjà.');
}
async function createParty(req, k, d) {
  const cust = k.kind === 'customer';
  await dupName(req, k, d.name, 0);
  const type = d.type || 'simple';
  if (type === 'temporary' && !d.validUntil) throw new HttpError(400, "Un client ou fournisseur temporaire a besoin d'une date de fin.");
  const cols = columns(k, d, null);
  const base = cust
    ? { org_id: req.org.id, branch_id: await A.branchOf(req, req.member.branch_id), name: d.name, created_at: nowISO() }
    : { org_id: req.org.id, name: d.name, contact: d.email || d.phone || '', notes: '', created_at: nowISO() };
  const all = { ...base, ...cols, party_type: type, valid_until: type === 'temporary' ? d.validUntil : null, type_changed_at: nowISO() };
  if (!cust && d.blocked) all.blocked = 1;
  const names = Object.keys(all);
  const id = Number((await db.prepare(`INSERT INTO ${k.table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`).run(...names.map((n) => all[n]))).lastInsertRowid);
  await db.prepare('INSERT INTO pty_type_log (org_id, kind, party_id, from_type, to_type, valid_until, reason, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(req.org.id, k.kind, id, '', type, all.valid_until, 'Création', req.user.id, nowISO());
  return id;
}
/** Enregistre les champs modifiés (et un changement de type éventuel, journalisé). */
async function saveParty(req, k, cur, d, { log = false } = {}) {
  if (d.name !== undefined && d.name.toLowerCase() !== cur.name.toLowerCase()) await dupName(req, k, d.name, cur.id);
  const cols = columns(k, d, cur);
  if (d.blocked !== undefined && k.kind === 'supplier') cols.blocked = d.blocked;
  if (d.lat === null) { cols.lat = null; cols.lng = null; cols.geo_source = ''; cols.geo_at = null; }
  const names = Object.keys(cols);
  if (names.length) await db.prepare(`UPDATE ${k.table} SET ${names.map((n) => `${n} = ?`).join(', ')} WHERE id = ?`).run(...names.map((n) => cols[n]), cur.id);
  if (d.type && (d.type !== cur.party_type || (d.type === 'temporary' && d.validUntil && d.validUntil !== cur.valid_until))) await changeType(req, k, cur, d.type, d.validUntil, log ? 'Import CSV' : '');
  void log;
}
async function changeType(req, k, cur, type, validUntil, reason) {
  if (type === 'temporary') { if (!validUntil) throw new HttpError(400, 'Indiquez la date de fin du statut temporaire.'); if (validUntil < today()) throw new HttpError(400, 'La date de fin est déjà passée.'); }
  const until = type === 'temporary' ? validUntil : null;
  await db.prepare(`UPDATE ${k.table} SET party_type = ?, valid_until = ?, type_changed_at = ? WHERE id = ?`).run(type, until, nowISO(), cur.id);
  await db.prepare('INSERT INTO pty_type_log (org_id, kind, party_id, from_type, to_type, valid_until, reason, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(req.org.id, k.kind, cur.id, cur.party_type, type, until, A.text(reason, 300), req.user.id, nowISO());
  await A.logActivity(req.org.id, req.user.id, 'crm', `${k.kind === 'customer' ? 'Client' : 'Fournisseur'} « ${cur.name} » : ${cur.party_type} → ${type}`);
}

router.post('/:kind', kindOf, async (req, res) => {
  const k = req.pk; const b = req.body || {};
  const d = readBody(req, k, b, null);
  if (b.type !== undefined) d.type = A.oneOf(b.type, TYPES, undefined, 'Type inconnu (simple, temporaire, permanent ou haut de gamme).');
  if (b.validUntil !== undefined) d.validUntil = A.date(b.validUntil);
  const id = await createParty(req, k, d);
  await A.logActivity(req.org.id, req.user.id, 'crm', `${k.kind === 'customer' ? 'Client' : 'Fournisseur'} « ${d.name} » ajouté (${d.type || 'simple'})`);
  res.status(201).json({ id });
});
router.put('/:kind/:id', kindOf, async (req, res) => {
  const k = req.pk; const cur = await rowOf(req, req.params.id); const b = req.body || {};
  const d = readBody(req, k, b, cur);
  if (b.type !== undefined || b.validUntil !== undefined) {
    if (!A.can(req, 'manager')) throw new HttpError(403, 'Seul un responsable change le type.');
    d.type = b.type === undefined ? cur.party_type : A.oneOf(b.type, TYPES, undefined, 'Type inconnu.');
    d.validUntil = b.validUntil === undefined ? cur.valid_until : A.date(b.validUntil);
  }
  await saveParty(req, k, cur, d);
  res.json({ ok: true });
});
// Changement de type : historique conservé (de, vers, date de fin, motif, auteur).
router.post('/:kind/:id/type', kindOf, mgr, async (req, res) => {
  const k = req.pk; const cur = await rowOf(req, req.params.id); const b = req.body || {};
  const type = A.oneOf(b.type, TYPES, undefined, 'Type inconnu (simple, temporaire, permanent ou haut de gamme).');
  if (type === cur.party_type && !(type === 'temporary' && b.validUntil && b.validUntil !== cur.valid_until)) throw new HttpError(400, 'Ce type est déjà celui de la fiche.');
  await changeType(req, k, cur, type, A.date(b.validUntil), b.reason);
  res.json({ ok: true });
});
router.post('/:kind/revert-expired', kindOf, mgr, async (req, res) => {
  const k = req.pk;
  const rows = await db.prepare(`SELECT * FROM ${k.table} WHERE org_id = ? AND party_type = 'temporary' AND valid_until < ?`).all(req.org.id, today());
  for (const r of rows) await changeType(req, k, r, 'simple', null, 'Fin de validité atteinte');
  res.json({ ok: true, reverted: rows.length });
});
router.post('/:kind/:id/location', kindOf, async (req, res) => {
  const k = req.pk; const cur = await rowOf(req, req.params.id); const b = req.body || {};
  if (b.lat === null && b.lng === null) { await saveParty(req, k, cur, { lat: null, lng: null }); return res.json({ ok: true }); }
  const d = { lat: lat(b.lat), lng: lng(b.lng), geoSource: A.oneOf(b.source, ['address', 'pin', 'manual'], 'pin', 'Origine inconnue (adresse, point sur la carte ou saisie).') };
  if (b.address !== undefined) d.address = A.text(b.address, 300);
  await saveParty(req, k, cur, d);
  res.json({ ok: true });
});
router.post('/:kind/:id/notes', kindOf, async (req, res) => {
  const k = req.pk; const cur = await rowOf(req, req.params.id);
  const body = A.text((req.body || {}).body, 1000, { required: true, msg: 'Écrivez la note.' });
  const id = Number((await db.prepare('INSERT INTO pty_notes (org_id, kind, party_id, body, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(req.org.id, k.kind, cur.id, body, req.user.id, nowISO())).lastInsertRowid);
  res.status(201).json({ id });
});
router.delete('/:kind/:id/notes/:nid', kindOf, mgr, async (req, res) => {
  const cur = await rowOf(req, req.params.id);
  await db.prepare('DELETE FROM pty_notes WHERE id = ? AND org_id = ? AND kind = ? AND party_id = ?').run(A.id(req.params.nid), req.org.id, req.pk.kind, cur.id);
  res.json({ ok: true });
});
/** Reporte les conditions effectives dans les champs déjà utilisés par la facturation (remise par défaut) et les achats (délai de paiement). */
router.post('/:kind/:id/apply-terms', kindOf, mgr, async (req, res) => {
  const k = req.pk; const cur = await rowOf(req, req.params.id); const tt = await typeTerms(req.org.id, k.kind);
  const e = effective(cur, k.kind, tt); const applied = {};
  if (k.kind === 'customer' && e.discountPct.value !== null) { await db.prepare('UPDATE customers SET default_discount = ? WHERE id = ?').run(e.discountPct.value, cur.id); applied.defaultDiscount = e.discountPct.value; }
  if (k.kind === 'supplier' && e.paymentDays.value !== null) { await db.prepare('UPDATE suppliers SET payment_days = ? WHERE id = ?').run(e.paymentDays.value, cur.id); applied.paymentDays = e.paymentDays.value; }
  if (!Object.keys(applied).length) throw new HttpError(400, "Aucune condition à appliquer : renseignez une remise (client) ou un délai de paiement (fournisseur) sur la fiche ou sur son type.");
  await A.logActivity(req.org.id, req.user.id, 'crm', `Conditions appliquées à « ${cur.name} »`);
  res.json({ ok: true, applied });
});

// ---------- Fiche complète : historique, activité dans les autres modules ----------
router.get('/:kind/:id', kindOf, async (req, res) => {
  const k = req.pk; const cur = await rowOf(req, req.params.id); const tt = await typeTerms(req.org.id, k.kind);
  const history = (await db.prepare('SELECT l.*, u.name AS author FROM pty_type_log l LEFT JOIN users u ON u.id = l.user_id WHERE l.org_id = ? AND l.kind = ? AND l.party_id = ? ORDER BY l.id DESC LIMIT 100').all(req.org.id, k.kind, cur.id))
    .map((l) => ({ id: Number(l.id), from: l.from_type, to: l.to_type, validUntil: l.valid_until, reason: l.reason, author: l.author || '', at: l.created_at }));
  const notes = (await db.prepare('SELECT n.*, u.name AS author FROM pty_notes n LEFT JOIN users u ON u.id = n.user_id WHERE n.org_id = ? AND n.kind = ? AND n.party_id = ? ORDER BY n.id DESC LIMIT 100').all(req.org.id, k.kind, cur.id))
    .map((n) => ({ id: Number(n.id), body: n.body, author: n.author || '', at: n.created_at }));
  const cnt = async (sql, ...a) => Number((await db.prepare(sql).get(...a)).n);
  let links;
  if (k.kind === 'customer') {
    const owed = await db.prepare("SELECT COALESCE(SUM(total - credited - paid), 0) AS n FROM documents WHERE customer_id = ? AND kind = 'invoice' AND status = 'sent'").get(cur.id);
    links = { crm: { invoices: await cnt("SELECT COUNT(*) AS n FROM documents WHERE customer_id = ? AND kind = 'invoice'", cur.id), quotes: await cnt("SELECT COUNT(*) AS n FROM documents WHERE customer_id = ? AND kind = 'quote'", cur.id), owed: Number(owed.n) || 0, defaultDiscount: Number(cur.default_discount) || 0 },
      commercial: { contacts: await cnt('SELECT COUNT(*) AS n FROM cp_contacts WHERE customer_id = ?', cur.id), opportunities: await cnt('SELECT COUNT(*) AS n FROM cp_opps WHERE customer_id = ?', cur.id) },
      transport: { deliveries: await cnt('SELECT COUNT(*) AS n FROM logistics_deliveries WHERE org_id = ? AND LOWER(customer_name) = LOWER(?)', req.org.id, cur.name) } };
  } else {
    const tre = await db.prepare('SELECT * FROM tre_terms WHERE org_id = ? AND supplier_id = ?').get(req.org.id, cur.id);
    links = { purchasing: { orders: await cnt('SELECT COUNT(*) AS n FROM pur_orders WHERE supplier_id = ?', cur.id), invoices: await cnt("SELECT COUNT(*) AS n FROM pur_invoices WHERE supplier_id = ? AND status <> 'cancelled'", cur.id), paymentDays: cur.payment_days === null ? null : Number(cur.payment_days) },
      treasury: tre ? { discountPct: Number(tre.discount_pct), discountDays: Number(tre.discount_days), priority: Number(tre.priority) } : null };
  }
  res.json({ party: view(cur, k.kind, tt, { history, notes, links }) });
});

module.exports = router;
Object.assign(module.exports, { TYPES, STATUSES, effective, typeTerms });
