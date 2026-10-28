'use strict';
// Passage de relais vers un humain : quand l'assistant commercial passe la main (chat.status = 'handoff'), le serveur envoie un message d'ALERTE par WhatsApp
// au responsable prioritaire, depuis le compte WhatsApp connecté à l'IA (QR : texte libre ; Meta : texte libre seulement si la fenêtre le permet).
// - Responsables : 1 à 3 (membres de l'équipe, rôle responsable ou plus), avec leur numéro WhatsApp et un ordre de priorité ; jamais le numéro d'un client.
//   Sans réglage : le propriétaire, sur le numéro connecté (« message à soi-même », autorisé en mode QR).
// - Garde-fous : un seul message par relais (clé unique), au plus N alertes WhatsApp par heure et par organisation (au-delà : UN message groupé), heures calmes
//   facultatives, journal. Toujours une notice dans l'application ; en cas d'échec ou d'impossibilité WhatsApp (non connecté, mode Meta et numéro de soi,
//   fenêtre fermée, heures calmes), notice + e-mail de secours.
const express = require('express');
const config = require('../config');
const { db, nowISO } = require('../db');
const A = require('./access');
const W = require('./w3');
const waOrg = require('../services/waOrg');
const { HttpError, asyncHandler, oneLine, log } = require('../util');

const router = express.Router({ mergeParams: true });
const digits = (x) => String(x || '').replace(/\D/g, '');
const CC = String(process.env.DEFAULT_COUNTRY_CODE || '237').replace(/\D/g, '');
const intl = (x) => { let d = digits(x); if (d.startsWith('00')) d = d.slice(2); return d.length === 9 && /^[2368]/.test(d) ? CC + d : d; };
const same = (a, b) => { const x = digits(a).slice(-9); return x.length >= 8 && x === digits(b).slice(-9); };
const HOUR = 3600000;

async function settingsOf(orgId) {
  const r = await db.prepare('SELECT * FROM relay_settings WHERE org_id = ?').get(orgId);
  return { enabled: r ? Boolean(r.enabled) : true, maxPerHour: r ? Number(r.max_per_hour) : 6, quietFrom: r ? Number(r.quiet_from) : -1, quietTo: r ? Number(r.quiet_to) : -1, tzOffset: r ? Number(r.tz_offset) : 60 };
}
async function connectedNumber(org) {
  if (waOrg.modeOf(org) === 'qr') { const r = await db.prepare('SELECT number FROM wa_qr_sessions WHERE org_id = ?').get(org.id); return r ? r.number : ''; }
  return org.wa_number || '';
}
/** Responsables désignés, par ordre de priorité ; à défaut le propriétaire sur le numéro connecté. */
async function contactsOf(org) {
  const rows = await db.prepare('SELECT c.*, u.name FROM relay_contacts c JOIN users u ON u.id = c.user_id WHERE c.org_id = ? ORDER BY c.priority').all(org.id);
  if (rows.length) return rows.map((r) => ({ id: r.id, userId: Number(r.user_id), name: r.name, phone: r.phone, priority: Number(r.priority), isDefault: false }));
  const o = await db.prepare('SELECT id, name FROM users WHERE id = ?').get(org.owner_id);
  const num = await connectedNumber(org);
  return o && num ? [{ id: 0, userId: Number(o.id), name: o.name, phone: num, priority: 1, isDefault: true }] : [];
}
const inQuiet = (s) => {
  if (s.quietFrom < 0 || s.quietTo < 0 || s.quietFrom === s.quietTo) return false;
  const h = new Date(Date.now() + s.tzOffset * 60000).getUTCHours();
  return s.quietFrom < s.quietTo ? h >= s.quietFrom && h < s.quietTo : h >= s.quietFrom || h < s.quietTo;
};
/** Notice dans l'application (sans e-mail). */
async function notice(orgId, userId, text, ref) {
  try { if (userId) await db.prepare('INSERT INTO notices (org_id, user_id, kind, text, ref, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(orgId, userId, 'handoff', oneLine(text, 300), String(ref).slice(0, 60), nowISO()); } catch (e) { log.warn('Relais : notice :', oneLine(e.message, 120)); }
}
const link = (org) => (config.siteUrl ? `${config.siteUrl.replace(/\/+$/, '')}/app/${org.id}/sales` : '');

async function describe(org, chat, reason) {
  const cu = chat.customer_id ? await db.prepare('SELECT name, phone FROM customers WHERE id = ?').get(chat.customer_id) : null;
  const phone = (cu && cu.phone) || (chat.channel === 'whatsapp' ? chat.contact : '');
  const last = await db.prepare("SELECT content FROM chat_messages WHERE chat_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1").get(chat.id);
  const neg = await db.prepare('SELECT actor, kind, item_label, price FROM neg_log WHERE org_id = ? AND chat_id = ? ORDER BY id DESC LIMIT 12').all(org.id, chat.id);
  const money = (n) => `${Number(n).toLocaleString('fr-FR')} ${org.currency}`.replace(/[  ]/g, ' ');
  let nego = '';
  if (neg.length) {
    const lastOffer = neg.find((x) => x.actor === 'customer' && x.kind === 'offer');
    const lastOurs = neg.find((x) => x.actor === 'assistant' && ['counter', 'accept', 'final'].includes(x.kind));
    nego = `Négociation : ${oneLine(neg[0].item_label, 60)}${lastOffer ? `, offre du client ${money(lastOffer.price)}` : ''}${lastOurs ? `, dernier prix proposé ${money(lastOurs.price)}` : ''}${neg.some((x) => x.kind === 'refused') ? ' (une demande a été refusée par le serveur)' : ''}.`;
  }
  const l = link(org);
  const HK = require('./handoff-kind');
  const commercial = chat.lead && /"intent"/.test(chat.lead); // passation de vente (commande, rendez-vous, service, prospect) : fiche détaillée
  const st = commercial ? await HK.status(org, chat) : null;
  const head = st ? `Brij-IA · ${HK.titleOf(st)} (${org.name})` : `Brij-IA : une conversation attend un conseiller (${org.name}).`;
  return [head, `Client : ${oneLine((cu && cu.name) || 'visiteur non enregistré', 60)}${phone ? ` (${phone})` : ''}.`, ...(st ? HK.detailLines(st, org) : []), `Motif : ${oneLine(reason || 'demande de passage de relais', 140)}.`,
    last ? `Dernier message du client : « ${oneLine(String(last.content).replace(/^\[[^\]]*\]\s*/, ''), 200)} »` : '', nego, `Conversation n° ${chat.id} : Assistant commercial > Conversations.${l ? ' ' + l : ''}`].filter(Boolean).join('\n');
}

/** Envoie le texte au premier responsable joignable. Renvoie { ok, to, errors }. */
async function sendWhatsApp(org, contacts, text) {
  const errors = [];
  if (!waOrg.isConnected(org)) return { ok: false, errors: ["WhatsApp n'est pas connecté."] };
  const mine = await connectedNumber(org);
  for (const c of contacts) {
    if (waOrg.modeOf(org) !== 'qr' && same(c.phone, mine)) { errors.push(`${c.name} : le numéro connecté ne peut pas s'écrire à lui-même en mode Meta.`); continue; }
    try { await waOrg.sendText(org, intl(c.phone), text); return { ok: true, to: c, self: same(c.phone, mine), errors }; } catch (e) { errors.push(`${c.name} : ${oneLine(String(e.message).replace(/^.*HTTP \d+ : /, ''), 120)}`); }
  }
  return { ok: false, errors };
}
const setLog = async (id, o) => await db.prepare('UPDATE relay_log SET channel = ?, status = ?, detail = ?, contact_user = ? WHERE id = ?').run(o.channel || '', o.status, oneLine(o.detail || '', 300), o.user || null, id);

/** Point d'entrée (appelé par sales-public.js au passage de relais). Ne plante jamais l'appelant. */
async function notifyHandoff(org, chat, reason) {
  try {
    const st = await settingsOf(org.id);
    if (!st.enabled) return { skipped: 'disabled' };
    const now = Date.now();
    const key = `h:${chat.id}:${Math.floor(now / (6 * HOUR))}`; // un seul message par relais (même en cas d'appels multiples ou de plusieurs serveurs)
    const claim = await db.prepare("INSERT INTO relay_log (org_id, chat_id, dedupe_key, status, created_at) VALUES (?, ?, ?, 'pending', ?) ON CONFLICT DO NOTHING").run(org.id, chat.id, key, nowISO());
    if (!claim.changes) return { skipped: 'duplicate' };
    const row = await db.prepare('SELECT id FROM relay_log WHERE org_id = ? AND dedupe_key = ?').get(org.id, key);
    const contacts = await contactsOf(org);
    const text = await describe(org, chat, reason);
    const users = [...new Set(contacts.map((c) => c.userId))];
    const alertUsers = async (withMail, t) => { if (!users.length) { if (withMail) await W.pushRole(org.id, 'manager', 'handoff', t, 'chat:' + chat.id); else for (const m of await db.prepare("SELECT user_id FROM org_members WHERE org_id = ? AND role IN ('manager','admin','owner')").all(org.id)) await notice(org.id, m.user_id, t, 'chat:' + chat.id); return; } for (const u of users) { if (withMail) await W.push(org.id, u, 'handoff', t, 'chat:' + chat.id); else await notice(org.id, u, t, 'chat:' + chat.id); } };
    const short = `Une conversation attend un conseiller : ${oneLine(reason || 'passage de relais', 100)} (conversation n° ${chat.id}).`;
    if (inQuiet(st)) { await setLog(row.id, { channel: 'email', status: 'quiet', detail: 'heures calmes : notice et e-mail, pas de WhatsApp' }); await alertUsers(true, short); return { status: 'quiet' }; }
    const sentLastHour = Number((await db.prepare("SELECT COUNT(*) c FROM relay_log WHERE org_id = ? AND channel = 'whatsapp' AND status = 'sent' AND created_at > ?").get(org.id, new Date(now - HOUR).toISOString())).c);
    if (sentLastHour >= st.maxPerHour) {
      await setLog(row.id, { channel: 'notice', status: 'rate', detail: `plafond de ${st.maxPerHour} alertes WhatsApp par heure : alerte regroupée` });
      await alertUsers(false, short);
      const gk = `g:${Math.floor(now / HOUR)}`;
      const g = await db.prepare("INSERT INTO relay_log (org_id, chat_id, dedupe_key, status, created_at) VALUES (?, NULL, ?, 'pending', ?) ON CONFLICT DO NOTHING").run(org.id, gk, nowISO());
      if (g.changes) {
        const gid = (await db.prepare('SELECT id FROM relay_log WHERE org_id = ? AND dedupe_key = ?').get(org.id, gk)).id;
        const r = await sendWhatsApp(org, contacts, `Brij-IA (${org.name}) : plusieurs conversations attendent un conseiller. Ouvrez Assistant commercial > Conversations.${link(org) ? ' ' + link(org) : ''}`);
        await setLog(gid, { channel: 'whatsapp', status: r.ok ? 'grouped' : 'failed', detail: r.ok ? 'message groupé' : r.errors.join(' ; '), user: r.ok ? r.to.userId : null });
      }
      return { status: 'rate' };
    }
    const r = await sendWhatsApp(org, contacts, text);
    if (r.ok) {
      await setLog(row.id, { channel: 'whatsapp', status: 'sent', detail: r.self ? 'message à soi-même (numéro connecté)' : '', user: r.to.userId });
      await alertUsers(false, short);
      return { status: 'sent', to: r.to.userId };
    }
    await setLog(row.id, { channel: 'email', status: contacts.length ? 'fallback_email' : 'fallback_email', detail: `WhatsApp : ${r.errors.join(' ; ') || 'aucun responsable joignable'} ; notice et e-mail envoyés` });
    await alertUsers(true, short);
    return { status: 'fallback_email', errors: r.errors };
  } catch (e) { log.warn('Relais WhatsApp :', oneLine(e.message, 160)); return { error: e.message }; }
}

// ---------- Routes (sous /sales/relay) ----------
router.get('/', A.need('manager'), asyncHandler(async (req, res) => {
  const org = req.org; const st = await settingsOf(org.id);
  const num = await connectedNumber(org);
  const contacts = await contactsOf(org);
  const members = await db.prepare("SELECT m.user_id, u.name, m.role FROM org_members m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? AND m.role IN ('manager','admin','owner') ORDER BY u.name").all(org.id);
  res.json({ settings: st, connected: waOrg.isConnected(org), mode: waOrg.modeOf(org), connectedNumber: num, contacts: contacts.map((c) => ({ userId: c.userId, name: c.name, phone: c.phone, priority: c.priority, isDefault: c.isDefault })), members: members.map((m) => ({ userId: Number(m.user_id), name: m.name, role: m.role })),
    log: (await db.prepare("SELECT l.*, u.name AS who FROM relay_log l LEFT JOIN users u ON u.id = l.contact_user WHERE l.org_id = ? AND l.status <> 'pending' ORDER BY l.id DESC LIMIT 30").all(org.id)).map((l) => ({ id: l.id, chatId: l.chat_id, channel: l.channel, status: l.status, detail: l.detail, to: l.who || null, at: l.created_at })) });
}));
router.put('/settings', A.need('admin'), asyncHandler(async (req, res) => {
  const b = req.body || {}; const cur = await settingsOf(req.org.id);
  const num = (v, def, lo, hi, msg) => { if (v === undefined) return def; const n = Number(v); if (!Number.isInteger(n) || n < lo || n > hi) throw new HttpError(400, msg); return n; };
  const maxPerHour = num(b.maxPerHour, cur.maxPerHour, 1, 60, "Le plafond d'alertes par heure est entre 1 et 60.");
  const quietFrom = num(b.quietFrom, cur.quietFrom, -1, 23, "L'heure de début des heures calmes est entre 0 et 23 (-1 pour aucune).");
  const quietTo = num(b.quietTo, cur.quietTo, -1, 23, "L'heure de fin des heures calmes est entre 0 et 23 (-1 pour aucune).");
  const tz = num(b.tzOffset, cur.tzOffset, -720, 840, 'Décalage horaire invalide (minutes par rapport à UTC).');
  const enabled = b.enabled === undefined ? cur.enabled : Boolean(b.enabled);
  await db.prepare(`INSERT INTO relay_settings (org_id, enabled, max_per_hour, quiet_from, quiet_to, tz_offset, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (org_id) DO UPDATE SET enabled = EXCLUDED.enabled, max_per_hour = EXCLUDED.max_per_hour, quiet_from = EXCLUDED.quiet_from, quiet_to = EXCLUDED.quiet_to, tz_offset = EXCLUDED.tz_offset, updated_at = EXCLUDED.updated_at`).run(req.org.id, enabled ? 1 : 0, maxPerHour, quietFrom, quietTo, tz, nowISO());
  await W.audit(req, 'relay_settings', null, 'update', cur, { enabled, maxPerHour, quietFrom, quietTo });
  res.json({ ok: true });
}));
router.put('/contacts', A.need('admin'), asyncHandler(async (req, res) => {
  const list = (req.body || {}).contacts;
  if (!Array.isArray(list) || list.length > 3) throw new HttpError(400, 'Indiquez 3 responsables au plus (liste vide = propriétaire sur le numéro connecté).');
  const rows = [];
  const clientPhones = [...(await db.prepare("SELECT phone FROM customers WHERE org_id = ? AND phone <> ''").all(req.org.id)).map((r) => r.phone), ...(await db.prepare("SELECT contact FROM chats WHERE org_id = ? AND channel = 'whatsapp'").all(req.org.id)).map((r) => r.contact)];
  for (const c of list) {
    const uid = A.id(c && c.userId, 'Choisissez un responsable.');
    const m = await db.prepare('SELECT role FROM org_members WHERE org_id = ? AND user_id = ?').get(req.org.id, uid);
    if (!m || A.RANK[m.role] < A.RANK.manager) throw new HttpError(400, 'Le responsable de relais doit être un responsable, administrateur ou propriétaire de l\'organisation.');
    const phone = intl(c.phone);
    if (phone.length < 8 || phone.length > 15) throw new HttpError(400, 'Numéro WhatsApp invalide : indiquez-le avec l\'indicatif du pays (ex. 237677112233).');
    if (clientPhones.some((p) => same(p, phone))) throw new HttpError(400, "Ce numéro est celui d'un client : un responsable de relais ne peut pas avoir un numéro de client.");
    if (rows.some((r) => same(r.phone, phone))) throw new HttpError(400, 'Deux responsables ont le même numéro.');
    rows.push({ uid, phone });
  }
  await db.transaction(async () => {
    await db.prepare('DELETE FROM relay_contacts WHERE org_id = ?').run(req.org.id);
    let p = 1; for (const r of rows) await db.prepare('INSERT INTO relay_contacts (org_id, user_id, phone, priority) VALUES (?, ?, ?, ?)').run(req.org.id, r.uid, r.phone, p++);
  })();
  await W.audit(req, 'relay_contacts', null, 'update', null, { count: rows.length });
  res.json({ ok: true });
}));
router.post('/test', A.need('admin'), asyncHandler(async (req, res) => {
  const contacts = await contactsOf(req.org);
  if (!contacts.length) throw new HttpError(400, "Aucun responsable de relais : désignez-en un, ou connectez WhatsApp (le propriétaire est alors utilisé sur le numéro connecté).");
  const text = `Brij-IA (${req.org.name}) : ceci est un TEST du passage de relais. Si vous le lisez, les alertes de conversations à reprendre arriveront ici.`;
  const r = await sendWhatsApp(req.org, contacts, text);
  const id = (await db.prepare("INSERT INTO relay_log (org_id, chat_id, dedupe_key, channel, status, detail, contact_user, created_at) VALUES (?, NULL, ?, ?, ?, ?, ?, ?) RETURNING id").get(req.org.id, `t:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`, r.ok ? 'whatsapp' : 'email', r.ok ? 'test_sent' : 'test_failed', oneLine(r.ok ? (r.self ? 'message à soi-même' : '') : r.errors.join(' ; '), 300), r.ok ? r.to.userId : null, nowISO())).id;
  res.json({ ok: r.ok, id, self: Boolean(r.self), error: r.ok ? '' : r.errors.join(' ; '), fallback: !r.ok ? "Aucun message WhatsApp n'a pu partir : en vrai relais, une notice et un e-mail seraient envoyés." : '' });
}));

module.exports = { router, notifyHandoff, settingsOf, contactsOf };
