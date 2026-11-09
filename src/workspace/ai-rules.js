'use strict';
// « Suivi de l'IA » : règles par contact (exclusion totale ou partielle de l'IA), brouillons à valider et journal.
// Une règle est rattachée à un CONTACT, pas à un fil de conversation : clé = fiche client si elle existe (c:<id>), sinon numéro normalisé (p:<9 derniers chiffres>),
// sinon identifiant de session (s:<session>, pour le site, Messenger et Instagram). La règle suit donc la personne sur tous ses fils.
// Toutes les vérifications se font ICI, côté serveur, juste avant chaque réponse ou action automatique de l'IA ; l'échéance est calculée à la lecture.
const { db, nowISO } = require('../db');
const { oneLine, log } = require('../util');

const DURATIONS = { '24h': 24 * 3600000, '7d': 7 * 86400000, none: null };
const HELD_TEXT = 'Merci, votre message est bien reçu. Un conseiller de l\'équipe va vous répondre très bientôt.';
const RESTRICT_TEXT = 'Merci pour votre message. Un conseiller de l\'équipe va s\'occuper de cette demande et vous répondra très bientôt.';
const FLAGS = [['noPrice', 'no_price'], ['noOrder', 'no_order'], ['noAppt', 'no_appt'], ['noFollowup', 'no_followup'], ['draft', 'draft']];

const digits = (v) => String(v || '').replace(/\D/g, '');
/** Les 9 derniers chiffres d'un numéro (un numéro camerounais sans l'indicatif et avec lui donnent la même clé). Vide si ce n'est pas un numéro. */
const phone9 = (v) => { const d = digits(v); return d.length >= 8 && d.length <= 15 ? d.slice(-9) : ''; };

// ---------- Identité d'un contact ----------
async function customerByPhone(orgId, p9) {
  if (!p9) return null;
  return await db.prepare("SELECT id, name, phone, stage FROM customers WHERE org_id = ? AND phone <> '' AND right(regexp_replace(phone, '\\D', '', 'g'), 9) = ? ORDER BY id LIMIT 1").get(orgId, p9) || null;
}
/** { customerId, phone9, session, keys[] } pour une conversation. */
async function identityOfChat(orgId, chat) {
  let customerId = chat.customer_id ? Number(chat.customer_id) : null;
  let p9 = chat.channel === 'whatsapp' ? phone9(chat.contact) : '';
  if (customerId && !p9) { const c = await db.prepare('SELECT phone FROM customers WHERE id = ? AND org_id = ?').get(customerId, orgId); p9 = c ? phone9(c.phone) : ''; }
  if (!customerId && p9) { const c = await customerByPhone(orgId, p9); if (c) customerId = Number(c.id); }
  const keys = [];
  if (customerId) keys.push(`c:${customerId}`);
  if (p9) keys.push(`p:${p9}`);
  if (chat.session) keys.push(`s:${chat.session}`);
  return { customerId, phone9: p9, session: chat.session || '', keys };
}
async function identityOfCustomer(orgId, customerId) {
  const c = await db.prepare('SELECT id, phone FROM customers WHERE id = ? AND org_id = ?').get(customerId, orgId);
  if (!c) return { customerId: null, phone9: '', session: '', keys: [] };
  const p9 = phone9(c.phone);
  return { customerId: Number(c.id), phone9: p9, session: '', keys: [`c:${c.id}`, ...(p9 ? [`p:${p9}`] : [])] };
}
/** Identité d'un numéro de téléphone seul (relances de factures, rappels de rendez-vous). */
async function identityOfPhone(orgId, phone, customerId) {
  const p9 = phone9(phone);
  let cid = customerId ? Number(customerId) : null;
  if (!cid && p9) { const c = await customerByPhone(orgId, p9); if (c) cid = Number(c.id); }
  const keys = [];
  if (cid) keys.push(`c:${cid}`);
  if (p9) keys.push(`p:${p9}`);
  return { customerId: cid, phone9: p9, session: '', keys };
}
const canonicalKey = (id) => (id.customerId ? `c:${id.customerId}` : id.phone9 ? `p:${id.phone9}` : id.session ? `s:${id.session}` : '');

// ---------- Règles ----------
const ruleView = (r) => ({
  id: Number(r.id), key: r.rkey, mode: r.mode, noPrice: Boolean(Number(r.no_price)), noOrder: Boolean(Number(r.no_order)), noAppt: Boolean(Number(r.no_appt)), noFollowup: Boolean(Number(r.no_followup)), draft: Boolean(Number(r.draft)),
  expiresAt: r.expires_at || null, reason: r.reason || '', label: r.label || '', createdBy: r.created_by ? Number(r.created_by) : null, createdAt: r.created_at,
});

async function addLog(orgId, { key = '', label = '', userId = null, action, detail = '', expiresAt = null }) {
  await db.prepare('INSERT INTO ai_rule_log (org_id, rkey, label, user_id, action, detail, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(orgId, key, oneLine(label, 120), userId || null, action, oneLine(detail, 300), expiresAt, nowISO());
}

/** Lève les règles échues (une seule fois, même si deux serveurs le font en même temps) et les inscrit au journal. */
async function liftExpired(orgId, rows) {
  const now = nowISO();
  const dead = (rows || []).filter((r) => r.expires_at && r.expires_at <= now);
  for (const r of dead) {
    const del = await db.prepare('DELETE FROM ai_rules WHERE id = ? AND expires_at <= ?').run(r.id, now);
    if (del.changes) await addLog(Number(r.org_id), { key: r.rkey, label: r.label, action: 'auto_lift', detail: JSON.stringify({ mode: r.mode }), expiresAt: r.expires_at });
  }
  return dead.length;
}
/** Tâche périodique : lève toutes les règles échues (le contrôle à la lecture suffit, ceci garde seulement le journal à jour). */
async function liftAllExpired() {
  const rows = await db.prepare('SELECT * FROM ai_rules WHERE expires_at IS NOT NULL AND expires_at <= ?').all(nowISO());
  for (const r of rows) await liftExpired(Number(r.org_id), [r]);
  return rows.length;
}

const NONE = Object.freeze({ excluded: false, noPrice: false, noOrder: false, noAppt: false, noFollowup: false, draft: false, rules: [], expiresAt: null });
/** Règles en vigueur pour une identité (les règles échues sont ignorées et levées). */
async function effectiveFor(orgId, ident) {
  if (!ident.keys.length) return NONE;
  const rows = await db.prepare(`SELECT * FROM ai_rules WHERE org_id = ? AND rkey IN (${ident.keys.map(() => '?').join(',')})`).all(orgId, ...ident.keys);
  if (!rows.length) return NONE;
  const now = nowISO();
  const live = rows.filter((r) => !r.expires_at || r.expires_at > now);
  if (live.length !== rows.length) await liftExpired(orgId, rows);
  if (!live.length) return NONE;
  const v = live.map(ruleView);
  const out = { excluded: v.some((r) => r.mode === 'full'), noPrice: v.some((r) => r.noPrice), noOrder: v.some((r) => r.noOrder), noAppt: v.some((r) => r.noAppt), noFollowup: v.some((r) => r.noFollowup), draft: v.some((r) => r.draft), rules: v };
  out.expiresAt = v.some((r) => !r.expiresAt) ? null : v.map((r) => r.expiresAt).sort().pop();
  return out;
}
const rulesOfChat = async (orgId, chat) => effectiveFor(orgId, await identityOfChat(orgId, chat));

/** L'IA a-t-elle le droit d'envoyer un message automatique (relance, rappel, campagne) à ce contact ? */
async function autoBlocked(orgId, { chat, customerId, phone }) {
  const ident = chat ? await identityOfChat(orgId, chat) : await identityOfPhone(orgId, phone, customerId);
  const r = await effectiveFor(orgId, ident);
  return r.excluded || r.noFollowup;
}

/** Enregistre (ou remplace) la règle d'un contact. Les anciennes règles du même contact sous une autre clé sont fusionnées dans celle-ci. */
async function setRule(orgId, ident, { mode, flags = {}, duration = 'none', reason = '', label = '', userId = null }) {
  const key = canonicalKey(ident);
  if (!key) throw new Error('contact inconnu');
  const ms = DURATIONS[duration];
  const expires = ms ? new Date(Date.now() + ms).toISOString() : null;
  const f = mode === 'full' ? {} : flags;
  const now = nowISO();
  const vals = FLAGS.map(([k]) => (f[k] ? 1 : 0));
  await db.transaction(async () => {
    const others = ident.keys.filter((k) => k !== key);
    if (others.length) await db.prepare(`DELETE FROM ai_rules WHERE org_id = ? AND rkey IN (${others.map(() => '?').join(',')})`).run(orgId, ...others);
    await db.prepare(`INSERT INTO ai_rules (org_id, rkey, mode, no_price, no_order, no_appt, no_followup, draft, expires_at, reason, label, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (org_id, rkey) DO UPDATE SET mode = EXCLUDED.mode, no_price = EXCLUDED.no_price, no_order = EXCLUDED.no_order, no_appt = EXCLUDED.no_appt, no_followup = EXCLUDED.no_followup, draft = EXCLUDED.draft,
        expires_at = EXCLUDED.expires_at, reason = EXCLUDED.reason, label = EXCLUDED.label, created_by = EXCLUDED.created_by, updated_at = EXCLUDED.updated_at`)
      .run(orgId, key, mode, ...vals, expires, oneLine(reason, 300), oneLine(label, 120), userId || null, now, now);
  })();
  await addLog(orgId, { key, label, userId, action: mode === 'full' ? 'exclude' : 'partial', detail: JSON.stringify({ flags: FLAGS.filter(([k]) => f[k]).map(([k]) => k), reason: oneLine(reason, 300) }), expiresAt: expires });
  return { key, expiresAt: expires };
}
function partialWords(f) {
  const w = [];
  if (f.noPrice) w.push('pas de prix ni de négociation');
  if (f.noOrder) w.push('pas de commande');
  if (f.noAppt) w.push('pas de rendez-vous');
  if (f.noFollowup) w.push('pas de relances automatiques');
  if (f.draft) w.push('réponses à valider');
  return w;
}
async function liftRule(orgId, ident, { userId = null, label = '' } = {}) {
  if (!ident.keys.length) return 0;
  const rows = await db.prepare(`SELECT * FROM ai_rules WHERE org_id = ? AND rkey IN (${ident.keys.map(() => '?').join(',')})`).all(orgId, ...ident.keys);
  if (!rows.length) return 0;
  await db.prepare(`DELETE FROM ai_rules WHERE org_id = ? AND rkey IN (${ident.keys.map(() => '?').join(',')})`).run(orgId, ...ident.keys);
  await addLog(orgId, { key: rows[0].rkey, label: label || rows[0].label, userId, action: 'lift', detail: JSON.stringify({ mode: rows[0].mode }) });
  return rows.length;
}
/** Quand une fiche client est créée pour un contact, ses règles passent sous la clé de la fiche. */
async function rekey(orgId, ident) {
  const key = canonicalKey(ident);
  if (!key) return;
  const others = ident.keys.filter((k) => k !== key);
  if (!others.length) return;
  const cur = await db.prepare('SELECT 1 FROM ai_rules WHERE org_id = ? AND rkey = ?').get(orgId, key);
  if (cur) await db.prepare(`DELETE FROM ai_rules WHERE org_id = ? AND rkey IN (${others.map(() => '?').join(',')})`).run(orgId, ...others);
  else {
    await db.prepare(`UPDATE ai_rules SET rkey = ? WHERE org_id = ? AND id = (SELECT id FROM ai_rules WHERE org_id = ? AND rkey IN (${others.map(() => '?').join(',')}) ORDER BY id LIMIT 1)`).run(key, orgId, orgId, ...others);
    await db.prepare(`DELETE FROM ai_rules WHERE org_id = ? AND rkey IN (${others.map(() => '?').join(',')})`).run(orgId, ...others);
  }
}

const SESS = { whatsapp: 'wa', messenger: 'ms', instagram: 'ig' };
/** L'IA est-elle exclue pour ce contact de messagerie ? (messages automatiques envoyés avant même l'enregistrement : fichier illisible, type non pris en charge…) */
async function excludedContact(org, channel, contact) {
  const session = `${SESS[channel] || 'x'}-${org.id}-${contact}`;
  const chat = await db.prepare('SELECT * FROM chats WHERE session = ? AND org_id = ?').get(session, org.id) || { channel, contact, session, customer_id: null };
  return (await rulesOfChat(org.id, chat)).excluded;
}

// ---------- Prévenir l'équipe ----------
/** Notice dans l'application pour la personne à qui la conversation est attribuée, sinon pour les responsables. Un seul message non lu par conversation et par type. */
async function notifyTeam(org, chat, kind, text) {
  try {
    let to = [];
    if (chat.assignee_id) { const m = await db.prepare('SELECT user_id FROM org_members WHERE org_id = ? AND user_id = ?').get(org.id, chat.assignee_id); if (m) to = [Number(m.user_id)]; }
    if (!to.length) to = (await db.prepare("SELECT user_id FROM org_members WHERE org_id = ? AND role IN ('manager','admin','owner')").all(org.id)).map((m) => Number(m.user_id));
    const ref = `aichat:${chat.id}`;
    for (const uid of to) {
      const dup = await db.prepare('SELECT 1 FROM notices WHERE org_id = ? AND user_id = ? AND kind = ? AND ref = ? AND is_read = 0').get(org.id, uid, kind, ref);
      if (!dup) await db.prepare('INSERT INTO notices (org_id, user_id, kind, text, ref, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(org.id, uid, kind, oneLine(text, 300), ref, nowISO());
    }
  } catch (e) { log.warn('Suivi de l\'IA : notice :', oneLine(e.message, 120)); }
}
const labelOfChat = async (chat) => {
  const cu = chat.customer_id ? await db.prepare('SELECT name FROM customers WHERE id = ?').get(chat.customer_id) : null;
  return cu ? cu.name : chat.contact ? `+${digits(chat.contact) || chat.contact}` : 'Visiteur du site';
};
/** Un message est arrivé d'un contact dont l'IA est exclue : il est déjà enregistré, l'équipe est prévenue. */
async function onHeldMessage(org, chat) {
  await notifyTeam(org, chat, 'aifollow', `Nouveau message de ${await labelOfChat(chat)} : l'IA est exclue pour ce contact, répondez-lui vous-même (Suivi de l'IA).`);
}

// ---------- Brouillons ----------
async function createDraft(org, chat, body, note) {
  const id = Number((await db.prepare("INSERT INTO ai_drafts (org_id, chat_id, body, status, created_at) VALUES (?, ?, ?, 'pending', ?)").run(org.id, chat.id, String(body).slice(0, 3000), nowISO())).lastInsertRowid);
  const label = await labelOfChat(chat);
  await addLog(org.id, { key: '', label, action: 'draft_created', detail: JSON.stringify({ note: note || '' }) });
  await notifyTeam(org, chat, 'aifollow', `Réponse à valider pour ${label} : l'IA a préparé un brouillon (Suivi de l'IA).`);
  return id;
}

// ---------- Prix : garde-fou pour « pas de prix » ----------
/** Le texte de l'IA cite-t-il un montant (nombre suivi de la monnaie) ou le prix exact d'un article du catalogue ? */
function mentionsPrice(org, text, catalog) {
  const t = String(text || '');
  const cur = String(org.currency || 'FCFA').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`\\d[\\d  .,]*\\s*(?:${cur}|F\\s?CFA|FCFA|XAF|XOF|francs?)`, 'i').test(t)) return true;
  const nums = (t.match(/\d[\d  .,]*\d|\d/g) || []).map((x) => Number(x.replace(/[\s .,]/g, ''))).filter((n) => n >= 100);
  return (catalog || []).some((c) => nums.includes(Number(c.price)));
}
/** Consigne ajoutée aux données de l'IA pour ce contact. */
function promptLines(r) {
  const l = [];
  if (r.noPrice) l.push('Pour cette personne : ne parle PAS de prix, de tarifs ni de remise, ne négocie pas ; dis qu\'un conseiller lui répondra sur les prix.');
  if (r.noOrder) l.push('Pour cette personne : ne prends PAS de commande ; dis qu\'un conseiller s\'en occupera.');
  if (r.noAppt) l.push('Pour cette personne : ne fixe PAS de rendez-vous ; dis qu\'un conseiller proposera un créneau.');
  return l;
}

module.exports = {
  DURATIONS, HELD_TEXT, RESTRICT_TEXT, FLAGS, NONE, phone9, digits, customerByPhone, identityOfChat, identityOfCustomer, identityOfPhone, canonicalKey, ruleView, addLog,
  effectiveFor, rulesOfChat, excludedContact, autoBlocked, setRule, liftRule, rekey, liftExpired, liftAllExpired, notifyTeam, onHeldMessage, createDraft, labelOfChat, mentionsPrice, promptLines, partialWords,
};
