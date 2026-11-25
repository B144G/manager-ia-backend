'use strict';
// Compte d'entreprise, étape 5 : PARTENAIRES (entre deux organisations d'entreprises différentes) et ESPACES PARTAGÉS (chat, réunions, bibliothèque),
// aussi utilisables entre organisations liées d'une même entreprise.
// Règles de fond : aucun accès aux discussions, réunions ou documents internes de l'autre côté ; seules des COPIES ou des fichiers désignés explicitement sont exposés,
// à des PERSONNES désignées explicitement (appartenance par personne), avec droits lecture / écriture / validation, expiration, révocation et journal d'audit visible des deux côtés.
// Les modules Chat interne (ci_), Réunions (mtg_) et Bibliothèque (lib_) ne sont PAS modifiés et gardent leur isolation par org_id.
const crypto = require('crypto');
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const Lim = require('./ent-limits');
const limits = require('../middleware/limits');
const { HttpError, parseJSON } = require('../util');

const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const newToken = () => 'PART-' + crypto.randomBytes(15).toString('hex').toUpperCase().match(/.{1,6}/g).join('-');
const normToken = (v) => String(v || '').trim().toUpperCase().replace(/\s+/g, '').slice(0, 80);
const TYPES = ['client', 'fournisseur', 'sous_traitant', 'transporteur', 'distributeur', 'cabinet_comptable', 'strategique'];
const RIGHTS = ['read', 'write', 'validate'];
const RK = { read: 1, write: 2, validate: 3 };
const KINDS = ['chat', 'meeting', 'library'];
const OBJ = { meeting: 'meeting', library_folder: 'library', library_document: 'library' };
const writeLimit = limits.make(10 * 60 * 1000, 600, 'Trop d\'actions à la suite. Patientez quelques minutes puis réessayez.');
const BAD_CODE = "Ce code de partenariat est invalide, expiré ou déjà utilisé. Demandez-en un nouveau à votre partenaire.";

const partners = express.Router({ mergeParams: true });
const shared = express.Router({ mergeParams: true });
for (const r of [partners, shared]) r.use((req, res, next) => (req.method === 'GET' || req.method === 'HEAD' ? next() : writeLimit(req, res, next)));

// ---------- Journal d'audit (visible des deux côtés, jamais de contenu) ----------
const audit = (req, { spaceId = null, partnershipId = null }, action, detail = '') => db.prepare('INSERT INTO shared_audit (space_id, partnership_id, org_id, user_id, action, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
  .run(spaceId, partnershipId, req.org.id, req.user.id, action, String(detail).slice(0, 300), nowISO());
const cleanContact = (c) => ({ name: A.text((c || {}).name, 100), email: A.text((c || {}).email, 120), phone: A.text((c || {}).phone, 40) });
const typeOf = (v, msg = 'Type de partenaire inconnu.') => A.oneOf(v, TYPES, undefined, msg);

// ---------- Partenariats ----------
async function partOf(req, id) {
  const p = await db.prepare('SELECT * FROM ent_partnerships WHERE id = ? AND (org_a = ? OR org_b = ?)').get(A.id(id), req.org.id, req.org.id);
  if (!p) throw new HttpError(404, 'Partenariat introuvable.');
  return sweep(p);
}
/** Durée écoulée : le partenariat expire et ses espaces passent en lecture seule. */
async function sweep(p) {
  if (p.status === 'active' && p.ends_at && Date.parse(p.ends_at) < Date.now()) { await close(p, null, 'expired', 'durée du partenariat écoulée'); return db.prepare('SELECT * FROM ent_partnerships WHERE id = ?').get(p.id); }
  return p;
}
/** Fin d'un partenariat (révocation ou expiration) : espaces archivés en lecture seule ; accès aux objets partagés coupés immédiatement ; l'historique de discussion reste lisible. */
async function close(p, byOrg, status, reason) {
  const now = nowISO();
  await db.transaction(async () => {
    await db.prepare('UPDATE ent_partnerships SET status = ?, revoked_at = ?, revoked_by_org = ?, revoke_reason = ? WHERE id = ?').run(status, now, byOrg, String(reason || '').slice(0, 200), p.id);
    await db.prepare("UPDATE shared_spaces SET status = 'archived', archived_at = ?, archive_reason = ? WHERE partnership_id = ? AND status = 'active'").run(now, status === 'expired' ? 'partenariat expiré' : 'partenariat révoqué', p.id);
    await db.prepare('UPDATE shared_space_objects SET revoked_at = ? WHERE revoked_at IS NULL AND space_id IN (SELECT id FROM shared_spaces WHERE partnership_id = ?)').run(now, p.id);
  })();
}
async function partView(req, p) {
  const mine = Number(p.org_a) === Number(req.org.id) ? 'a' : 'b';
  const otherId = mine === 'a' ? p.org_b : p.org_a;
  const other = otherId ? await db.prepare('SELECT o.id, o.name, e.name AS company FROM orgs o LEFT JOIN entreprises e ON e.id = o.entreprise_id WHERE o.id = ?').get(otherId) : null;
  const st = p.status === 'invited' && Date.parse(p.expires_at) < Date.now() ? 'expired' : p.status;
  return {
    id: Number(p.id), status: st, mine, label: p.label, myType: mine === 'a' ? p.type_a : p.type_b, theirType: mine === 'a' ? p.type_b : p.type_a,
    partner: other ? { orgName: other.name, company: other.company || other.name } : null, hint: mine === 'a' ? p.hint : undefined,
    expiresAt: p.expires_at, endsAt: p.ends_at, durationDays: p.duration_days, createdAt: p.created_at, confirmedAt: p.confirmed_at, revokedAt: p.revoked_at, revokeReason: p.revoke_reason,
    needsMyConfirmation: p.status === 'awaiting' && mine === 'a',
    myContact: parseJSON(mine === 'a' ? p.contact_a : p.contact_b, {}), theirContact: parseJSON(mine === 'a' ? p.contact_b : p.contact_a, {}),
  };
}
async function assertPartnerRoom(org, type) {
  const lim = await Lim.forOrg(org);
  const rows = await db.prepare("SELECT org_a, type_a, type_b FROM ent_partnerships WHERE (org_a = ? OR org_b = ?) AND status IN ('invited', 'awaiting', 'active')").all(org.id, org.id);
  if (rows.length >= lim.partners) throw new HttpError(403, `Votre abonnement permet ${lim.partners} partenaire(s) : la limite est atteinte. Passez à une offre supérieure ou mettez fin à un partenariat.`);
  const same = rows.filter((r) => (Number(r.org_a) === Number(org.id) ? r.type_a : r.type_b) === type).length;
  if (same >= lim.partnersPerType) throw new HttpError(403, `Votre abonnement permet ${lim.partnersPerType} partenaire(s) de ce type : la limite est atteinte.`);
}

partners.get('/', async (req, res) => {
  const rows = await db.prepare('SELECT * FROM ent_partnerships WHERE org_a = ? OR org_b = ? ORDER BY id DESC LIMIT 100').all(req.org.id, req.org.id);
  const list = []; for (const r of rows) list.push(await partView(req, await sweep(r)));
  const lim = await Lim.forOrg(req.org);
  res.json({ partners: list, types: TYPES, limits: { partners: lim.partners, perType: lim.partnersPerType }, canManage: A.can(req, 'admin') });
});

partners.post('/invite', A.need('admin'), async (req, res) => {
  const b = req.body || {};
  const type = typeOf(b.type, 'Choisissez le type de partenaire (client, fournisseur, sous-traitant…).');
  await assertPartnerRoom(req.org, type);
  const token = newToken(); const days = Math.min(Math.max(Number(b.days) || 7, 1), 30);
  const dur = b.durationDays === undefined || b.durationDays === null || b.durationDays === '' ? null : Math.min(Math.max(Number(b.durationDays) || 0, 30), 3650);
  const id = Number((await db.prepare('INSERT INTO ent_partnerships (org_a, ent_a, type_a, status, token_hash, hint, label, duration_days, contact_a, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(req.org.id, req.org.entreprise_id || null, type, 'invited', sha(token), token.slice(-4), A.text(b.label, 80), dur, JSON.stringify(cleanContact(b.contact)), req.user.id, nowISO(), new Date(Date.now() + days * 86400000).toISOString())).lastInsertRowid);
  await audit(req, { partnershipId: id }, 'invite', A.text(b.label, 80));
  res.status(201).json({ id, code: token, expiresAt: new Date(Date.now() + days * 86400000).toISOString() }); // montré une seule fois : seule l'empreinte est conservée
});

async function usableInvite(req, code) {
  const t = normToken(code);
  if (t.length < 10) throw new HttpError(400, BAD_CODE);
  const p = await db.prepare('SELECT * FROM ent_partnerships WHERE token_hash = ?').get(sha(t));
  if (!p || p.status !== 'invited' || Date.parse(p.expires_at) < Date.now()) throw new HttpError(400, BAD_CODE);
  if (Number(p.org_a) === Number(req.org.id) || (req.org.entreprise_id && Number(p.ent_a) === Number(req.org.entreprise_id))) throw new HttpError(400, "Ce code vient de votre propre entreprise. Entre organisations d'une même entreprise, utilisez les liens d'association.");
  return p;
}
partners.post('/preview', A.need('admin'), limits.make(15 * 60 * 1000, 30, 'Trop de tentatives. Réessayez dans quelques minutes.', { shared: true, prefix: 'partpreview' }), async (req, res) => {
  const p = await usableInvite(req, (req.body || {}).code);
  const a = await db.prepare('SELECT o.name, e.name AS company FROM orgs o LEFT JOIN entreprises e ON e.id = o.entreprise_id WHERE o.id = ?').get(p.org_a);
  res.json({ company: a.company || a.name, orgName: a.name, theirView: p.type_a, durationDays: p.duration_days, expiresAt: p.expires_at, contact: parseJSON(p.contact_a, {}).name || '' });
});
partners.post('/join', A.need('admin'), limits.make(15 * 60 * 1000, 20, 'Trop de tentatives. Réessayez dans quelques minutes.', { shared: true, prefix: 'partjoin' }), async (req, res) => {
  const b = req.body || {};
  const p = await usableInvite(req, b.code);
  const type = typeOf(b.type, "Choisissez comment vous qualifiez ce partenaire (client, fournisseur, sous-traitant…).");
  await assertPartnerRoom(req.org, type);
  const r = await db.prepare("UPDATE ent_partnerships SET org_b = ?, ent_b = ?, type_b = ?, contact_b = ?, status = 'awaiting', joined_by = ?, joined_at = ? WHERE id = ? AND status = 'invited'")
    .run(req.org.id, req.org.entreprise_id || null, type, JSON.stringify(cleanContact(b.contact)), req.user.id, nowISO(), p.id);
  if (!r.changes) throw new HttpError(400, BAD_CODE);
  await audit(req, { partnershipId: Number(p.id) }, 'join', 'demande de partenariat acceptée de ce côté, en attente de confirmation');
  res.json({ id: Number(p.id), status: 'awaiting' });
});
partners.post('/:id/confirm', A.need('admin'), async (req, res) => {
  const p = await partOf(req, req.params.id);
  if (p.status !== 'awaiting' || Number(p.org_a) !== Number(req.org.id)) throw new HttpError(409, "Ce partenariat n'attend pas votre confirmation.");
  const now = nowISO();
  const ends = p.duration_days ? new Date(Date.now() + p.duration_days * 86400000).toISOString() : null;
  await db.transaction(async () => {
    await db.prepare("UPDATE ent_partnerships SET status = 'active', confirmed_by = ?, confirmed_at = ?, ends_at = ? WHERE id = ?").run(req.user.id, now, ends, p.id);
    const sid = Number((await db.prepare("INSERT INTO shared_spaces (kind, title, scope, partnership_id, owner_org_id, status, created_by, created_at) VALUES ('chat', ?, 'partner', ?, ?, 'active', ?, ?)")
      .run('Canal partenaire', p.id, p.org_a, req.user.id, now)).lastInsertRowid);
    for (const o of [p.org_a, p.org_b]) await db.prepare('INSERT INTO shared_space_orgs (space_id, org_id) VALUES (?, ?)').run(sid, o);
    // membres désignés : la personne qui a confirmé (côté A) et celle qui a accepté (côté B), si elle est toujours dans son organisation ; chaque côté ajoute ensuite les siens
    await db.prepare('INSERT INTO shared_space_members (space_id, org_id, user_id, rights, added_by, added_at) VALUES (?, ?, ?, ?, ?, ?)').run(sid, p.org_a, req.user.id, 'write', req.user.id, now);
    if (p.joined_by && await db.prepare('SELECT 1 FROM org_members WHERE org_id = ? AND user_id = ?').get(p.org_b, p.joined_by)) await db.prepare('INSERT INTO shared_space_members (space_id, org_id, user_id, rights, added_by, added_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING').run(sid, p.org_b, p.joined_by, 'write', req.user.id, now);
    await audit(req, { partnershipId: Number(p.id), spaceId: sid }, 'confirm', 'partenariat confirmé des deux côtés ; canal créé');
  })();
  res.json({ ok: true });
});
partners.post('/:id/decline', A.need('admin'), async (req, res) => {
  const p = await partOf(req, req.params.id);
  if (p.status !== 'awaiting' || Number(p.org_a) !== Number(req.org.id)) throw new HttpError(409, "Ce partenariat n'attend pas votre réponse.");
  await db.prepare("UPDATE ent_partnerships SET status = 'declined', revoked_at = ?, revoked_by_org = ? WHERE id = ?").run(nowISO(), req.org.id, p.id);
  await audit(req, { partnershipId: Number(p.id) }, 'decline', '');
  res.json({ ok: true });
});
partners.delete('/:id', A.need('admin'), async (req, res) => {
  const p = await partOf(req, req.params.id);
  if (p.status !== 'invited' || Number(p.org_a) !== Number(req.org.id)) throw new HttpError(409, "Seule une invitation en attente peut être annulée.");
  await db.prepare("UPDATE ent_partnerships SET status = 'cancelled', revoked_at = ?, revoked_by_org = ? WHERE id = ?").run(nowISO(), req.org.id, p.id);
  await audit(req, { partnershipId: Number(p.id) }, 'cancel', '');
  res.json({ ok: true });
});
partners.post('/:id/revoke', A.need('admin'), async (req, res) => {
  const p = await partOf(req, req.params.id);
  if (!['active', 'awaiting'].includes(p.status)) throw new HttpError(409, "Ce partenariat n'est pas actif.");
  await close(p, req.org.id, 'revoked', A.text((req.body || {}).reason, 200));
  await audit(req, { partnershipId: Number(p.id) }, 'revoke', A.text((req.body || {}).reason, 200));
  res.json({ ok: true });
});
partners.put('/:id/contacts', A.need('admin'), async (req, res) => {
  const p = await partOf(req, req.params.id);
  const col = Number(p.org_a) === Number(req.org.id) ? 'contact_a' : 'contact_b';
  await db.prepare(`UPDATE ent_partnerships SET ${col} = ? WHERE id = ?`).run(JSON.stringify(cleanContact(req.body)), p.id);
  await audit(req, { partnershipId: Number(p.id) }, 'contact', '');
  res.json({ ok: true });
});
partners.get('/:id', async (req, res) => {
  const p = await partOf(req, req.params.id);
  const log = await db.prepare(`SELECT a.action, a.detail, a.created_at AS at, u.name, o.name AS org FROM shared_audit a LEFT JOIN users u ON u.id = a.user_id LEFT JOIN orgs o ON o.id = a.org_id WHERE a.partnership_id = ? ORDER BY a.id DESC LIMIT 100`).all(p.id);
  const spaces = await db.prepare('SELECT id, kind, title, status FROM shared_spaces WHERE partnership_id = ? ORDER BY id').all(p.id);
  res.json({ partner: await partView(req, p), log, spaces: spaces.map((s) => ({ id: Number(s.id), kind: s.kind, title: s.title, status: s.status })) });
});

// ---------- Espaces partagés ----------
async function sweepSpace(s) {
  if (s.status === 'active' && s.expires_at && Date.parse(s.expires_at) < Date.now()) { await db.prepare("UPDATE shared_spaces SET status = 'archived', archived_at = ?, archive_reason = 'expiré' WHERE id = ?").run(nowISO(), s.id); s.status = 'archived'; }
  return s;
}
/** Espace dont MON organisation est partie. `needMember` : il faut y être membre désigné (contenu) ; sinon un administrateur de mon organisation suffit (gestion de mes membres). */
async function spaceOf(req, id, { needMember = false } = {}) {
  const s = await db.prepare('SELECT s.* FROM shared_spaces s JOIN shared_space_orgs o ON o.space_id = s.id AND o.org_id = ? WHERE s.id = ?').get(req.org.id, A.id(id));
  if (!s) throw new HttpError(404, 'Espace introuvable.');
  await sweepSpace(s);
  const mem = await db.prepare('SELECT * FROM shared_space_members WHERE space_id = ? AND user_id = ? AND org_id = ? AND removed_at IS NULL').get(s.id, req.user.id, req.org.id);
  if (needMember && !mem) throw new HttpError(404, 'Espace introuvable.'); // un non-membre ne sait même pas que l'espace existe
  if (!mem && !A.can(req, 'admin')) throw new HttpError(404, 'Espace introuvable.');
  return { s, mem };
}
const canWrite = (s, mem) => s.status === 'active' && mem && RK[mem.rights] >= RK.write;
const names = async (ids) => { const m = new Map(); if (ids.length) for (const r of await db.prepare(`SELECT id, name FROM users WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids)) m.set(Number(r.id), r.name); return m; };

shared.get('/spaces', async (req, res) => {
  const rows = await db.prepare(`SELECT s.*, (SELECT COUNT(*) FROM shared_space_objects x WHERE x.space_id = s.id AND x.revoked_at IS NULL) AS objects,
    (SELECT COUNT(*) FROM shared_space_members m WHERE m.space_id = s.id AND m.removed_at IS NULL) AS members,
    (SELECT 1 FROM shared_space_members m2 WHERE m2.space_id = s.id AND m2.user_id = ? AND m2.org_id = ? AND m2.removed_at IS NULL) AS mine
    FROM shared_spaces s JOIN shared_space_orgs o ON o.space_id = s.id AND o.org_id = ? ORDER BY s.id DESC LIMIT 200`).all(req.user.id, req.org.id, req.org.id);
  const out = [];
  for (const r of rows) {
    if (!r.mine && !A.can(req, 'admin')) continue;
    await sweepSpace(r);
    const orgs = await db.prepare('SELECT o.id, o.name FROM shared_space_orgs so JOIN orgs o ON o.id = so.org_id WHERE so.space_id = ?').all(r.id);
    out.push({ id: Number(r.id), kind: r.kind, title: r.title, scope: r.scope, status: r.status, archiveReason: r.archive_reason, expiresAt: r.expires_at, owner: Number(r.owner_org_id) === Number(req.org.id), member: Boolean(r.mine), objects: Number(r.objects), members: Number(r.members), orgs: orgs.map((o) => o.name), createdAt: r.created_at });
  }
  res.json({ spaces: out, canManage: A.can(req, 'admin') });
});

shared.post('/spaces', A.need('admin'), async (req, res) => {
  const b = req.body || {};
  const kind = A.oneOf(b.kind, KINDS, undefined, 'Type d\'espace inconnu (chat, réunion ou bibliothèque).');
  const title = A.text(b.title, 100, { required: true, msg: "Donnez un nom à l'espace." });
  const scope = A.oneOf(b.scope, ['partner', 'linked'], 'partner', 'Portée inconnue.');
  let other; let partnershipId = null; let entId = null;
  if (scope === 'partner') {
    const p = await partOf(req, b.partnershipId);
    if (p.status !== 'active') throw new HttpError(409, "Le partenariat n'est pas actif : confirmez-le avant de créer un espace.");
    other = Number(p.org_a) === Number(req.org.id) ? p.org_b : p.org_a; partnershipId = Number(p.id);
  } else {
    other = A.id(b.otherOrgId, 'Organisation invalide.');
    const o = await db.prepare('SELECT * FROM orgs WHERE id = ?').get(other);
    if (!o || !req.org.entreprise_id || Number(o.entreprise_id) !== Number(req.org.entreprise_id) || Number(o.id) === Number(req.org.id)) throw new HttpError(404, 'Organisation liée introuvable.'); // seulement une organisation de la MÊME entreprise
    entId = Number(req.org.entreprise_id);
  }
  const lim = await Lim.forOrg(req.org);
  if (Number((await db.prepare("SELECT COUNT(*) c FROM shared_spaces WHERE owner_org_id = ? AND status = 'active'").get(req.org.id)).c) >= lim.sharedSpaces) throw new HttpError(403, `Votre abonnement permet ${lim.sharedSpaces} espace(s) partagé(s) actif(s) : la limite est atteinte.`);
  const exp = b.expiresInDays ? new Date(Date.now() + Math.min(Math.max(Number(b.expiresInDays) || 0, 1), 3650) * 86400000).toISOString() : null;
  const now = nowISO();
  const id = await db.transaction(async () => {
    const sid = Number((await db.prepare('INSERT INTO shared_spaces (kind, title, scope, partnership_id, entreprise_id, owner_org_id, status, expires_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(kind, title, scope, partnershipId, entId, req.org.id, 'active', exp, req.user.id, now)).lastInsertRowid);
    for (const o of [req.org.id, other]) await db.prepare('INSERT INTO shared_space_orgs (space_id, org_id) VALUES (?, ?)').run(sid, o);
    const mem = Array.isArray(b.members) && b.members.length ? b.members : [{ userId: req.user.id, rights: 'validate' }];
    for (const m of mem) await addMember(req, sid, req.org.id, m);
    return sid;
  })();
  await audit(req, { spaceId: id, partnershipId }, 'space_created', `${kind} · ${title}`);
  res.status(201).json({ id });
});
async function addMember(req, spaceId, orgId, m) {
  const uid = A.id(m.userId, 'Personne invalide.'); const rights = A.oneOf(m.rights, RIGHTS, 'read', 'Droit inconnu (lecture, écriture ou validation).');
  if (!await db.prepare('SELECT 1 FROM org_members WHERE org_id = ? AND user_id = ?').get(orgId, uid)) throw new HttpError(400, "Cette personne ne fait pas partie de votre organisation.");
  await db.prepare(`INSERT INTO shared_space_members (space_id, org_id, user_id, rights, added_by, added_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (space_id, user_id) DO UPDATE SET rights = EXCLUDED.rights, removed_at = NULL`).run(spaceId, orgId, uid, rights, req.user.id, nowISO());
}

shared.get('/spaces/:id', async (req, res) => {
  const { s, mem } = await spaceOf(req, req.params.id);
  const members = await db.prepare('SELECT m.user_id, m.org_id, m.rights, u.name, o.name AS org FROM shared_space_members m JOIN users u ON u.id = m.user_id JOIN orgs o ON o.id = m.org_id WHERE m.space_id = ? AND m.removed_at IS NULL ORDER BY m.id').all(s.id);
  const orgs = await db.prepare('SELECT o.id, o.name FROM shared_space_orgs so JOIN orgs o ON o.id = so.org_id WHERE so.space_id = ?').all(s.id);
  const out = { space: { id: Number(s.id), kind: s.kind, title: s.title, scope: s.scope, status: s.status, archiveReason: s.archive_reason, expiresAt: s.expires_at, owner: Number(s.owner_org_id) === Number(req.org.id), partnershipId: s.partnership_id ? Number(s.partnership_id) : null }, orgs: orgs.map((o) => ({ id: Number(o.id), name: o.name, mine: Number(o.id) === Number(req.org.id) })),
    members: members.map((m) => ({ userId: Number(m.user_id), name: m.name, org: m.org, mine: Number(m.org_id) === Number(req.org.id), rights: m.rights })), me: mem ? { rights: mem.rights, canWrite: canWrite(s, mem) } : null, canManage: A.can(req, 'admin') };
  if (mem) { // le contenu n'est montré qu'aux membres désignés
    const objs = await db.prepare(`SELECT o.*, og.name AS org FROM shared_space_objects o JOIN orgs og ON og.id = o.org_id WHERE o.space_id = ? ORDER BY o.id DESC`).all(s.id);
    out.objects = objs.map((o) => ({ id: Number(o.id), type: o.object_type, title: o.title, org: o.org, mine: Number(o.org_id) === Number(req.org.id), rights: o.rights, expiresAt: o.expires_at, revoked: Boolean(o.revoked_at) || (o.expires_at && Date.parse(o.expires_at) < Date.now()), refreshedAt: o.refreshed_at || o.created_at }));
  }
  res.json(out);
});
shared.put('/spaces/:id/members', A.need('admin'), async (req, res) => {
  const { s } = await spaceOf(req, req.params.id);
  if (s.status !== 'active') throw new HttpError(409, 'Cet espace est archivé : plus aucune modification.');
  const list = Array.isArray((req.body || {}).members) ? req.body.members : null;
  if (!list) throw new HttpError(400, 'Indiquez les membres.');
  const keep = new Set();
  await db.transaction(async () => {
    for (const m of list) { await addMember(req, s.id, req.org.id, m); keep.add(Number(m.userId)); }
    // seuls les membres de MON organisation sont gérés ici ; l'autre côté désigne les siens
    await db.prepare(`UPDATE shared_space_members SET removed_at = ? WHERE space_id = ? AND org_id = ? AND removed_at IS NULL${keep.size ? ` AND user_id NOT IN (${[...keep].map(() => '?').join(',')})` : ''}`).run(nowISO(), s.id, req.org.id, ...keep);
  })();
  await audit(req, { spaceId: Number(s.id), partnershipId: s.partnership_id ? Number(s.partnership_id) : null }, 'members', `${keep.size} membre(s) de cette organisation`);
  res.json({ ok: true });
});
shared.post('/spaces/:id/archive', A.need('admin'), async (req, res) => {
  const { s } = await spaceOf(req, req.params.id);
  if (Number(s.owner_org_id) !== Number(req.org.id)) throw new HttpError(403, "Seule l'organisation propriétaire de l'espace peut l'archiver.");
  await db.prepare("UPDATE shared_spaces SET status = 'archived', archived_at = ?, archive_reason = 'archivé' WHERE id = ?").run(nowISO(), s.id);
  await db.prepare('UPDATE shared_space_objects SET revoked_at = ? WHERE space_id = ? AND revoked_at IS NULL').run(nowISO(), s.id);
  await audit(req, { spaceId: Number(s.id), partnershipId: s.partnership_id ? Number(s.partnership_id) : null }, 'archived', '');
  res.json({ ok: true });
});

// --- Discussion ---
shared.get('/spaces/:id/messages', async (req, res) => {
  const { s } = await spaceOf(req, req.params.id, { needMember: true });
  const after = Math.max(Number(req.query.after) || 0, 0);
  const rows = await db.prepare('SELECT m.id, m.body, m.created_at, m.user_id, m.org_id, u.name, o.name AS org FROM shared_messages m JOIN users u ON u.id = m.user_id JOIN orgs o ON o.id = m.org_id WHERE m.space_id = ? AND m.id > ? ORDER BY m.id DESC LIMIT 100').all(s.id, after);
  res.json({ messages: rows.reverse().map((m) => ({ id: Number(m.id), body: m.body, at: m.created_at, userId: Number(m.user_id), name: m.name, org: m.org, mine: Number(m.user_id) === Number(req.user.id) })), archived: s.status !== 'active' });
});
shared.post('/spaces/:id/messages', async (req, res) => {
  const { s, mem } = await spaceOf(req, req.params.id, { needMember: true });
  if (!canWrite(s, mem)) throw new HttpError(403, s.status !== 'active' ? 'Cet espace est archivé : lecture seule.' : "Vous avez un droit de lecture seule dans cet espace.");
  const body = A.text((req.body || {}).body, 2000, { required: true, msg: 'Écrivez votre message.' });
  const id = Number((await db.prepare('INSERT INTO shared_messages (space_id, org_id, user_id, body, created_at) VALUES (?, ?, ?, ?, ?)').run(s.id, req.org.id, req.user.id, body, nowISO())).lastInsertRowid);
  res.status(201).json({ id });
});

// --- Fichiers déposés (lecture + dépôt) ---
const rawBody = express.raw({ type: () => true, limit: '16mb' });
shared.get('/spaces/:id/files', async (req, res) => {
  const { s } = await spaceOf(req, req.params.id, { needMember: true });
  const rows = await db.prepare('SELECT f.id, f.name, f.mime, f.size, f.created_at, f.user_id, u.name AS who, o.name AS org FROM shared_files f JOIN users u ON u.id = f.user_id JOIN orgs o ON o.id = f.org_id WHERE f.space_id = ? AND f.deleted_at IS NULL ORDER BY f.id DESC').all(s.id);
  res.json({ files: rows.map((f) => ({ id: Number(f.id), name: f.name, mime: f.mime, size: Number(f.size), at: f.created_at, who: f.who, org: f.org })) });
});
shared.post('/spaces/:id/files', rawBody, async (req, res) => {
  const { s, mem } = await spaceOf(req, req.params.id, { needMember: true });
  if (!canWrite(s, mem)) throw new HttpError(403, s.status !== 'active' ? 'Cet espace est archivé : lecture seule.' : "Vous avez un droit de lecture seule dans cet espace.");
  const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const lim = await Lim.forOrg(req.org);
  if (!buf.length) throw new HttpError(400, 'Fichier vide.');
  if (buf.length > lim.fileMb * 1024 * 1024) throw new HttpError(413, `Fichier trop gros : ${lim.fileMb} Mo au plus avec votre abonnement.`);
  const name = A.text(String(req.query.name || 'fichier').replace(/[\\/]/g, '_'), 120, { required: true });
  const mime = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(String(req.headers['x-file-type'] || '')) ? String(req.headers['x-file-type']) : 'application/octet-stream';
  const id = Number((await db.prepare('INSERT INTO shared_files (space_id, org_id, user_id, name, mime, size, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(s.id, req.org.id, req.user.id, name, mime, buf.length, buf, nowISO())).lastInsertRowid);
  await audit(req, { spaceId: Number(s.id), partnershipId: s.partnership_id ? Number(s.partnership_id) : null }, 'file_added', name);
  res.status(201).json({ id });
});
const sendFile = (res, name, mime, data) => {
  res.set({ 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`, 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Cache-Control': 'private, no-store' });
  res.end(data); void mime;
};
shared.get('/spaces/:id/files/:fid', async (req, res) => {
  const { s } = await spaceOf(req, req.params.id, { needMember: true });
  const f = await db.prepare('SELECT * FROM shared_files WHERE id = ? AND space_id = ? AND deleted_at IS NULL').get(A.id(req.params.fid), s.id);
  if (!f) throw new HttpError(404, 'Fichier introuvable.');
  await audit(req, { spaceId: Number(s.id), partnershipId: s.partnership_id ? Number(s.partnership_id) : null }, 'file_read', f.name);
  sendFile(res, f.name, f.mime, f.data);
});
shared.delete('/spaces/:id/files/:fid', async (req, res) => {
  const { s } = await spaceOf(req, req.params.id, { needMember: true });
  const f = await db.prepare('SELECT * FROM shared_files WHERE id = ? AND space_id = ? AND deleted_at IS NULL').get(A.id(req.params.fid), s.id);
  if (!f) throw new HttpError(404, 'Fichier introuvable.');
  if (s.status !== 'active') throw new HttpError(403, 'Cet espace est archivé : lecture seule.');
  if (Number(f.user_id) !== Number(req.user.id) && !(A.can(req, 'admin') && Number(f.org_id) === Number(req.org.id))) throw new HttpError(403, "Seule la personne qui l'a déposé, ou un administrateur de son organisation, peut le retirer.");
  await db.prepare('UPDATE shared_files SET deleted_at = ? WHERE id = ?').run(nowISO(), f.id);
  await audit(req, { spaceId: Number(s.id), partnershipId: s.partnership_id ? Number(s.partnership_id) : null }, 'file_removed', f.name);
  res.json({ ok: true });
});

// --- Objets partagés explicitement (réunions, dossiers et documents de la bibliothèque) ---
async function snapshotOf(req, type, id, opts) {
  if (type === 'meeting') {
    const m = await db.prepare('SELECT * FROM mtg_meetings WHERE id = ? AND org_id = ?').get(id, req.org.id);
    if (!m || m.confidential && !A.can(req, 'admin')) throw new HttpError(404, 'Réunion introuvable.');
    const agenda = await db.prepare('SELECT position, title, owner_name, duration_min, notes FROM mtg_agenda WHERE meeting_id = ? AND org_id = ? ORDER BY position, id').all(m.id, req.org.id);
    let minutes = null;
    if (opts.includeMinutes && m.minutes_status === 'validated') { const x = await db.prepare('SELECT version, content FROM mtg_minutes WHERE meeting_id = ? AND org_id = ? ORDER BY version DESC LIMIT 1').get(m.id, req.org.id); if (x) minutes = { version: Number(x.version), content: String(x.content || '').slice(0, 60000) }; }
    return { title: m.title, snap: { title: m.title, date: m.date, startTime: m.start_time, durationMin: m.duration_min, place: m.place, link: m.link, objective: m.objective, agenda: agenda.map((a) => ({ position: a.position, title: a.title, owner: a.owner_name, durationMin: a.duration_min, notes: A.text(a.notes, 500) })), minutes } };
  }
  if (type === 'library_document') {
    const d = await db.prepare('SELECT * FROM lib_docs WHERE id = ? AND org_id = ? AND deleted_at IS NULL').get(id, req.org.id);
    if (!d) throw new HttpError(404, 'Document introuvable.');
    return { title: d.name, snap: { name: d.name, mime: d.mime, size: Number(d.size), version: Number(d.version) } };
  }
  const f = await db.prepare('SELECT * FROM lib_folders WHERE id = ? AND org_id = ?').get(id, req.org.id);
  if (!f) throw new HttpError(404, 'Dossier introuvable.');
  return { title: f.name, snap: { name: f.name } };
}
shared.post('/spaces/:id/objects', A.need('admin'), async (req, res) => {
  const { s } = await spaceOf(req, req.params.id);
  const b = req.body || {};
  if (s.status !== 'active') throw new HttpError(409, 'Cet espace est archivé : plus aucun partage.');
  const type = A.oneOf(b.type, Object.keys(OBJ), undefined, "Type d'objet inconnu.");
  if (OBJ[type] !== s.kind) throw new HttpError(400, s.kind === 'chat' ? "Un espace de discussion ne partage pas d'objets : créez un espace réunion ou bibliothèque." : `Cet espace ${s.kind === 'meeting' ? 'de réunion' : 'de bibliothèque'} ne reçoit pas ce type d'objet.`);
  const rights = A.oneOf(b.rights, RIGHTS, 'read', 'Droit inconnu.');
  const lim = await Lim.forOrg(req.org);
  if (Number((await db.prepare('SELECT COUNT(*) c FROM shared_space_objects WHERE space_id = ? AND revoked_at IS NULL').get(s.id)).c) >= lim.objectsPerSpace) throw new HttpError(403, `Votre abonnement permet ${lim.objectsPerSpace} objet(s) partagé(s) par espace.`);
  const { title, snap } = await snapshotOf(req, type, A.id(b.id, 'Objet invalide.'), { includeMinutes: b.includeMinutes === true });
  const exp = b.expiresInDays ? new Date(Date.now() + Math.min(Math.max(Number(b.expiresInDays) || 0, 1), 3650) * 86400000).toISOString() : null;
  const id = Number((await db.prepare('INSERT INTO shared_space_objects (space_id, org_id, object_type, object_id, title, rights, snapshot, expires_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(s.id, req.org.id, type, A.id(b.id), title, rights, JSON.stringify({ ...snap, includeMinutes: b.includeMinutes === true }), exp, req.user.id, nowISO())).lastInsertRowid);
  await audit(req, { spaceId: Number(s.id), partnershipId: s.partnership_id ? Number(s.partnership_id) : null }, 'object_shared', `${type} · ${title} · ${rights}`);
  res.status(201).json({ id });
});
async function objectOf(req, s, oid) {
  const o = await db.prepare('SELECT * FROM shared_space_objects WHERE id = ? AND space_id = ?').get(A.id(oid), s.id);
  if (!o) throw new HttpError(404, 'Objet introuvable.');
  return o;
}
const live = (o) => !o.revoked_at && !(o.expires_at && Date.parse(o.expires_at) < Date.now());
shared.get('/spaces/:id/objects/:oid', async (req, res) => {
  const { s } = await spaceOf(req, req.params.id, { needMember: true });
  const o = await objectOf(req, s, req.params.oid);
  if (!live(o)) throw new HttpError(403, "Ce partage est terminé (révoqué ou expiré) : l'accès est coupé.");
  const out = { id: Number(o.id), type: o.object_type, title: o.title, rights: o.rights, org: Number(o.org_id) === Number(req.org.id) ? 'mine' : 'other', snapshot: parseJSON(o.snapshot, {}), expiresAt: o.expires_at };
  if (o.object_type === 'library_folder') out.docs = (await db.prepare('SELECT id, name, mime, size, version FROM lib_docs WHERE folder_id = ? AND org_id = ? AND deleted_at IS NULL ORDER BY name LIMIT 200').all(o.object_id, o.org_id)).map((d) => ({ id: Number(d.id), name: d.name, mime: d.mime, size: Number(d.size), version: Number(d.version) }));
  out.validations = (await db.prepare('SELECT v.decision, v.comment, v.created_at AS at, u.name, og.name AS org FROM shared_validations v JOIN users u ON u.id = v.user_id JOIN orgs og ON og.id = v.org_id WHERE v.object_id = ? ORDER BY v.id DESC').all(o.id)).map((v) => ({ decision: v.decision, comment: v.comment, at: v.at, name: v.name, org: v.org }));
  res.json(out);
});
shared.get('/spaces/:id/objects/:oid/files/:docId', async (req, res) => {
  const { s } = await spaceOf(req, req.params.id, { needMember: true });
  const o = await objectOf(req, s, req.params.oid);
  if (!live(o) || s.status !== 'active') throw new HttpError(403, "Ce partage est terminé (révoqué ou expiré) : l'accès est coupé.");
  if (!['library_folder', 'library_document'].includes(o.object_type)) throw new HttpError(404, 'Fichier introuvable.');
  const docId = A.id(req.params.docId);
  // seul le document partagé, ou un document du dossier partagé, peut être lu : jamais un autre document de la bibliothèque
  const d = o.object_type === 'library_document' ? (Number(o.object_id) === docId ? await db.prepare('SELECT * FROM lib_docs WHERE id = ? AND org_id = ? AND deleted_at IS NULL').get(docId, o.org_id) : null)
    : await db.prepare('SELECT * FROM lib_docs WHERE id = ? AND org_id = ? AND folder_id = ? AND deleted_at IS NULL').get(docId, o.org_id, o.object_id);
  if (!d) throw new HttpError(404, 'Fichier introuvable.');
  const v = await db.prepare('SELECT name, mime, data FROM lib_versions WHERE doc_id = ? AND org_id = ? AND n = ?').get(d.id, o.org_id, d.version);
  if (!v) throw new HttpError(404, 'Fichier introuvable.');
  await audit(req, { spaceId: Number(s.id), partnershipId: s.partnership_id ? Number(s.partnership_id) : null }, 'library_read', d.name); // journal des accès
  sendFile(res, d.name, v.mime, v.data);
});
shared.post('/spaces/:id/objects/:oid/refresh', A.need('admin'), async (req, res) => {
  const { s } = await spaceOf(req, req.params.id);
  const o = await objectOf(req, s, req.params.oid);
  if (Number(o.org_id) !== Number(req.org.id)) throw new HttpError(403, "Seule l'organisation qui partage peut republier.");
  if (!live(o) || s.status !== 'active') throw new HttpError(409, 'Ce partage est terminé.');
  const old = parseJSON(o.snapshot, {});
  const { title, snap } = await snapshotOf(req, o.object_type, Number(o.object_id), { includeMinutes: old.includeMinutes === true });
  await db.prepare('UPDATE shared_space_objects SET snapshot = ?, title = ?, refreshed_at = ? WHERE id = ?').run(JSON.stringify({ ...snap, includeMinutes: old.includeMinutes === true }), title, nowISO(), o.id);
  await audit(req, { spaceId: Number(s.id), partnershipId: s.partnership_id ? Number(s.partnership_id) : null }, 'object_refreshed', title);
  res.json({ ok: true });
});
shared.delete('/spaces/:id/objects/:oid', A.need('admin'), async (req, res) => {
  const { s } = await spaceOf(req, req.params.id);
  const o = await objectOf(req, s, req.params.oid);
  if (Number(o.org_id) !== Number(req.org.id)) throw new HttpError(403, "Seule l'organisation qui partage peut retirer ce partage.");
  await db.prepare('UPDATE shared_space_objects SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(nowISO(), o.id);
  await audit(req, { spaceId: Number(s.id), partnershipId: s.partnership_id ? Number(s.partnership_id) : null }, 'object_revoked', o.title);
  res.json({ ok: true });
});
shared.post('/spaces/:id/objects/:oid/validate', async (req, res) => {
  const { s, mem } = await spaceOf(req, req.params.id, { needMember: true });
  const o = await objectOf(req, s, req.params.oid);
  if (!live(o) || s.status !== 'active') throw new HttpError(403, "Ce partage est terminé : plus de validation possible.");
  if (!mem || RK[mem.rights] < RK.validate || RK[o.rights] < RK.validate) throw new HttpError(403, "Vous n'avez pas le droit de valider cet objet.");
  const decision = A.oneOf((req.body || {}).decision, ['approved', 'rejected'], undefined, 'Décision inconnue (approuvé ou refusé).');
  await db.prepare('INSERT INTO shared_validations (object_id, org_id, user_id, decision, comment, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(o.id, req.org.id, req.user.id, decision, A.text((req.body || {}).comment, 500), nowISO());
  await audit(req, { spaceId: Number(s.id), partnershipId: s.partnership_id ? Number(s.partnership_id) : null }, 'validated', `${o.title} · ${decision}`);
  res.json({ ok: true });
});
shared.get('/spaces/:id/audit', async (req, res) => {
  const { s } = await spaceOf(req, req.params.id, { needMember: true });
  const rows = await db.prepare('SELECT a.action, a.detail, a.created_at AS at, u.name, o.name AS org FROM shared_audit a LEFT JOIN users u ON u.id = a.user_id LEFT JOIN orgs o ON o.id = a.org_id WHERE a.space_id = ? ORDER BY a.id DESC LIMIT 200').all(s.id);
  res.json({ log: rows });
});
/** Ce que je peux partager : mes réunions et mon dossier / documents de bibliothèque (liste pour le formulaire de partage). */
shared.get('/shareable', A.need('admin'), async (req, res) => {
  const kind = String(req.query.kind || '');
  if (kind === 'meeting') return res.json({ items: (await db.prepare("SELECT id, title, date FROM mtg_meetings WHERE org_id = ? AND (confidential = 0 OR confidential IS NULL) ORDER BY date DESC LIMIT 100").all(req.org.id)).map((m) => ({ type: 'meeting', id: Number(m.id), title: m.title, sub: m.date })) });
  if (kind === 'library') return res.json({ items: [...(await db.prepare('SELECT id, name FROM lib_folders WHERE org_id = ? ORDER BY name LIMIT 100').all(req.org.id)).map((f) => ({ type: 'library_folder', id: Number(f.id), title: f.name, sub: 'dossier' })), ...(await db.prepare('SELECT id, name FROM lib_docs WHERE org_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 100').all(req.org.id)).map((d) => ({ type: 'library_document', id: Number(d.id), title: d.name, sub: 'document' }))] });
  res.json({ items: [] });
});
/** Mes personnes qui peuvent être désignées dans un espace (membres de MON organisation). */
shared.get('/people', A.need('admin'), async (req, res) => {
  res.json({ people: (await db.prepare('SELECT m.user_id, u.name, m.title FROM org_members m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? ORDER BY u.name').all(req.org.id)).map((p) => ({ userId: Number(p.user_id), name: p.name, title: p.title })) });
});
/** Organisations liées de la même entreprise (pour créer un espace entre organisations liées). */
shared.get('/linked-orgs', A.need('admin'), async (req, res) => {
  if (!req.org.entreprise_id) return res.json({ orgs: [] });
  res.json({ orgs: (await db.prepare('SELECT id, name FROM orgs WHERE entreprise_id = ? AND id <> ? ORDER BY id').all(req.org.entreprise_id, req.org.id)).map((o) => ({ id: Number(o.id), name: o.name })) });
});

module.exports = { partners, shared, TYPES };
