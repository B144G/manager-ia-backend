'use strict';
// Sous-application « Assistant commercial » (responsables et plus) : réglages de l'assistant public, catalogue, conversations avec
// les prospects, commandes à valider et résultats par campagne. L'assistant lui-même est dans sales-public.js.
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const crm = require('./crm');
const L = require('./sales-assign');
const stt = require('../services/stt');
const vault = require('../services/vault');
const waOrg = require('../services/waOrg');
const B = require('./sales-brief');
const N = require('./negotiation');
const P = require('./pricing');
const tts = require('../services/tts');
const metaChat = require('../services/metaChat');
const crypto = require('crypto');
const config = require('../config');
const limits = require('../middleware/limits');
const { HttpError, asyncHandler, oneLine, fetchJson } = require('../util');

const router = express.Router({ mergeParams: true });
router.use(A.need('manager'));
router.use('/wa', require('./wa-out').router);
router.use('/', require('./wa-media').router);
router.use('/', require('./sales-appt').router);
router.use('/meta', require('./meta-channels').settings);
router.use('/wa-qr', require('./wa-qr'));
router.use('/negotiation', N.router);
router.use('/relay', require('./relay').router);
router.use('/followups', require('./followups').router);

const today = () => nowISO().slice(0, 10);
const catItem = (r) => ({ id: r.id, name: r.name, description: r.description, price: r.price, unit: r.unit, floorPrice: Number(r.floor_price) || null, maxDiscount: Number(r.max_discount) || null, negotiable: P.floorOf(r) > 0, floor: P.floorOf(r) || null, tiers: P.readTiers(r.tiers), active: Boolean(r.active), photos: r.n_img || 0, videos: r.n_vid || 0 });

const waNumberOf = (org, qrNumber) => (waOrg.modeOf(org) === 'qr' && qrNumber ? qrNumber : org.wa_number);
router.get('/', async (req, res) => {
  const o = req.org.id;
  const qrRow = waOrg.modeOf(req.org) === 'qr' ? await db.prepare('SELECT number FROM wa_qr_sessions WHERE org_id = ?').get(o) : null;
  const qrNumber = qrRow ? qrRow.number : '';
  const since = new Date(Date.now() - 7 * 86400000).toISOString();
  const one = async (sql, ...a) => (await db.prepare(sql).get(o, ...a)).c;
  res.json({
    settings: { chatEnabled: Boolean(req.org.chat_enabled), salesInfo: req.org.sales_info, token: A.can(req, 'admin') ? req.org.intake_token : undefined, voice: stt.isConfigured(), autoAssign: Boolean(req.org.auto_assign), waNumber: waNumberOf(req.org, qrNumber), waMode: waOrg.modeOf(req.org), waConnected: waOrg.isConnected(req.org), replyDelay: req.org.reply_delay, voiceReply: req.org.voice_reply, handoffOrder: Boolean(req.org.handoff_order), handoffAppt: Boolean(req.org.handoff_appt), handoffKind: req.org.handoff_kind || 'auto', apptReminder: Boolean(req.org.appt_reminder), ttsAvailable: tts.isConfigured() },
    stats: {
      chats7: await one('SELECT COUNT(*) c FROM chats WHERE org_id = ? AND created_at >= ?', since),
      prospects: await one("SELECT COUNT(*) c FROM customers WHERE org_id = ? AND stage = 'prospect'"),
      pendingOrders: await one("SELECT COUNT(*) c FROM documents WHERE org_id = ? AND kind = 'order' AND status = 'pending'"),
      ordered: (await db.prepare("SELECT COALESCE(SUM(total), 0) t FROM documents WHERE org_id = ? AND kind = 'order' AND status IN ('pending','confirmed','invoiced')").get(o)).t,
      catalog: await one('SELECT COUNT(*) c FROM catalog WHERE org_id = ? AND active = 1'),
      waiting: await one("SELECT COUNT(*) c FROM chats WHERE org_id = ? AND status = 'handoff'"),
      appointments: await one("SELECT COUNT(*) c FROM appointments WHERE org_id = ? AND status = 'pending'"),
    },
  });
});

router.put('/settings', A.need('admin'), async (req, res) => {
  const b = req.body || {};
  const on = b.chatEnabled === undefined ? req.org.chat_enabled : b.chatEnabled ? 1 : 0;
  if (on && !await db.prepare('SELECT 1 FROM catalog WHERE org_id = ? AND active = 1').get(req.org.id)) throw new HttpError(400, "Ajoutez d'abord au moins un article au catalogue : l'assistant a besoin de vos prix pour répondre.");
  // Délai avant la réponse de l'IA (messageries seulement) : 0 = tout de suite, jusqu'à 180 s ; les messages reçus pendant l'attente sont lus ensemble.
  let delay = req.org.reply_delay;
  if (b.replyDelay !== undefined) { delay = Number(b.replyDelay); if (!Number.isInteger(delay) || delay < 0 || delay > 180) throw new HttpError(400, 'Le délai de réponse est un nombre de secondes entre 0 et 180 (3 minutes).'); }
  const voice = b.voiceReply === undefined ? req.org.voice_reply : A.oneOf(b.voiceReply, ['off', 'mirror', 'always'], undefined, 'Réponse vocale : choix inconnu.');
  const rem = b.apptReminder === undefined ? req.org.appt_reminder : b.apptReminder ? 1 : 0;
  const hOrder = b.handoffOrder === undefined ? req.org.handoff_order : b.handoffOrder ? 1 : 0; const hAppt = b.handoffAppt === undefined ? req.org.handoff_appt : b.handoffAppt ? 1 : 0;
  if (b.handoffKind !== undefined && !['auto', 'order', 'service', 'prospect'].includes(b.handoffKind)) throw new HttpError(400, "Type d'entreprise inconnu : auto, order (articles), service ou prospect (établissement).");
  const hKind = b.handoffKind === undefined ? (req.org.handoff_kind || 'auto') : b.handoffKind;
  await db.prepare('UPDATE orgs SET chat_enabled = ?, sales_info = ?, auto_assign = ?, reply_delay = ?, voice_reply = ?, handoff_order = ?, handoff_appt = ?, appt_reminder = ?, handoff_kind = ? WHERE id = ?').run(on, b.salesInfo === undefined ? req.org.sales_info : A.text(b.salesInfo, 2500), b.autoAssign === undefined ? req.org.auto_assign : b.autoAssign ? 1 : 0, delay, voice, hOrder, hAppt, rem, hKind, req.org.id);
  await A.logActivity(req.org.id, req.user.id, 'sales', on ? "Assistant commercial public activé" : 'Assistant commercial public désactivé');
  res.json({ ok: true });
});

// ---------- Catalogue ----------
router.get('/catalog', async (req, res) => res.json({ items: (await db.prepare("SELECT c.*, (SELECT COUNT(*) FROM catalog_media m WHERE m.item_id = c.id AND m.kind = 'image') AS n_img, (SELECT COUNT(*) FROM catalog_media m WHERE m.item_id = c.id AND m.kind = 'video') AS n_vid FROM catalog c WHERE c.org_id = ? ORDER BY c.active DESC, c.name COLLATE NOCASE").all(req.org.id)).map(catItem) }));
/** Prix, plancher, remise maximale et paliers d'un article, validés ensemble (le plancher ne peut pas dépasser le prix de liste). */
function priceFields(b, cur) {
  const price = b.price === undefined ? Number(cur.price) : A.amount(b.price);
  const fp = b.floorPrice === undefined ? Number(cur.floor_price) || 0 : (b.floorPrice === null || b.floorPrice === '' || Number(b.floorPrice) === 0 ? 0 : A.amount(b.floorPrice));
  if (fp > price) throw new HttpError(400, 'Le prix plancher ne peut pas dépasser le prix de liste.');
  let md = b.maxDiscount === undefined ? Number(cur.max_discount) || 0 : (b.maxDiscount === null || b.maxDiscount === '' ? 0 : Number(String(b.maxDiscount).replace(',', '.')));
  if (!Number.isFinite(md) || md < 0 || md > 90) throw new HttpError(400, 'La remise maximale est un pourcentage entre 0 et 90.');
  md = Math.round(md * 10) / 10;
  const floor = P.floorOf({ price, floor_price: fp, max_discount: md });
  const tiers = b.tiers === undefined ? P.readTiers(cur.tiers) : P.cleanTiers(b.tiers, price, floor);
  return { price, fp, md, tiers: JSON.stringify(tiers) };
}
router.post('/catalog', async (req, res) => {
  const b = req.body || {};
  if ((await db.prepare('SELECT COUNT(*) c FROM catalog WHERE org_id = ?').get(req.org.id)).c >= 200) throw new HttpError(403, 'Le catalogue est limité à 200 articles.');
  const pf = priceFields({ ...b, price: A.amount(b.price) }, { price: 0 });
  const id = (await db.prepare('INSERT INTO catalog (org_id, name, description, price, unit, created_at, floor_price, max_discount, tiers) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(req.org.id, A.text(b.name, 100, { required: true, msg: "Indiquez le nom de l'article." }), A.text(b.description, 300), pf.price, A.text(b.unit, 30), nowISO(), pf.fp, pf.md, pf.tiers)).lastInsertRowid;
  res.status(201).json({ id: Number(id) });
});
router.put('/catalog/:id', async (req, res) => {
  const r = await db.prepare('SELECT * FROM catalog WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!r) throw new HttpError(404, 'Article introuvable.');
  const b = req.body || {};
  const pf = priceFields(b, r);
  await db.prepare('UPDATE catalog SET name = ?, description = ?, price = ?, unit = ?, active = ?, floor_price = ?, max_discount = ?, tiers = ? WHERE id = ?').run(
    b.name === undefined ? r.name : A.text(b.name, 100, { required: true, msg: "Indiquez le nom de l'article." }), b.description === undefined ? r.description : A.text(b.description, 300),
    pf.price, b.unit === undefined ? r.unit : A.text(b.unit, 30), b.active === undefined ? r.active : b.active ? 1 : 0, pf.fp, pf.md, pf.tiers, r.id);
  if (pf.price !== Number(r.price) || pf.fp !== Number(r.floor_price) || pf.md !== Number(r.max_discount)) await require('./w3').audit(req, 'catalog_price', r.id, 'update', { price: r.price, floor: r.floor_price, maxDiscount: r.max_discount }, { price: pf.price, floor: pf.fp, maxDiscount: pf.md });
  res.json({ ok: true });
});
router.delete('/catalog/:id', async (req, res) => {
  const r = await db.prepare('DELETE FROM catalog WHERE id = ? AND org_id = ?').run(A.id(req.params.id), req.org.id);
  if (!r.changes) throw new HttpError(404, 'Article introuvable.');
  res.json({ ok: true });
});

// ---------- Conversations ----------
router.get('/chats', async (req, res) => {
  const rows = await db.prepare(`SELECT c.id, c.campaign, c.status, c.channel, c.contact, c.created_at, c.updated_at, c.assignee_id, c.lead, au.name AS assignee, cu.name AS customer, cu.phone, cu.stage,
      (SELECT content FROM chat_messages m WHERE m.chat_id = c.id AND m.role = 'user' ORDER BY m.id DESC LIMIT 1) AS lastText,
      (SELECT COUNT(*) FROM chat_messages m WHERE m.chat_id = c.id) AS messages
    FROM chats c LEFT JOIN customers cu ON cu.id = c.customer_id LEFT JOIN users au ON au.id = c.assignee_id WHERE c.org_id = ? ORDER BY c.updated_at DESC LIMIT 100`).all(req.org.id);
  res.json({ chats: rows.map((r) => ({ id: r.id, campaign: r.campaign, status: r.status, channel: r.channel, contact: r.contact, assigneeId: r.assignee_id, assignee: r.assignee, temperature: L.cleanLead(JSON.parse(r.lead || '{}')).temperature || null, at: r.updated_at, customer: r.customer, phone: r.phone, stage: r.stage, lastText: r.lastText, messages: r.messages })) });
});
router.get('/chats/:id', async (req, res) => {
  const c = await db.prepare('SELECT * FROM chats WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!c) throw new HttpError(404, 'Conversation introuvable.');
  res.json({ campaign: c.campaign, status: c.status, channel: c.channel, contact: c.contact, assigneeId: c.assignee_id, lead: L.cleanLead(JSON.parse(c.lead || '{}')), summary: L.leadSummary(c.lead), brief: B.read(c), appointments: await db.prepare("SELECT id, date, time, purpose, status FROM appointments WHERE chat_id = ? ORDER BY id DESC LIMIT 5").all(c.id), negotiation: await N.logOfChat(req.org.id, c.id), messages: await db.prepare('SELECT role, content, created_at AS at FROM chat_messages WHERE chat_id = ? ORDER BY id LIMIT 200').all(c.id) });
});

// Dossier préparé par l'IA interne : régénérer, ou appliquer la fiche client trouvée.
router.post('/chats/:id/brief', asyncHandler(async (req, res) => {
  const c = await db.prepare('SELECT * FROM chats WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!c) throw new HttpError(404, 'Conversation introuvable.');
  const b = await B.build(req.org, c.id);
  if (!b) throw new HttpError(503, "Le dossier n'a pas pu être préparé (IA indisponible ou quota atteint).");
  res.json({ brief: b });
}));
router.post('/chats/:id/apply-brief', async (req, res) => {
  const c = await db.prepare('SELECT * FROM chats WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!c) throw new HttpError(404, 'Conversation introuvable.');
  const done = await B.apply(req.org, c);
  await A.logActivity(req.org.id, req.user.id, 'sales', 'Fiche client complétée avec le dossier de l\'IA');
  res.json({ ok: true, done });
});

// Pièce jointe d'un prospect (photo ou PDF). Servie telle quelle mais neutralisée : type fixé d'après le contenu, jamais exécutable, jamais mise en cache.
async function sendMedia(req, res, chat) {
  const m = await db.prepare('SELECT mime, data FROM chat_media WHERE id = ? AND chat_id = ?').get(A.id(req.params.mid), chat.id);
  if (!m) throw new HttpError(404, 'Fichier introuvable.');
  res.set({ 'Content-Type': m.mime, 'Content-Length': m.data.length, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Content-Disposition': 'inline; filename="piece-jointe' + (m.mime === 'application/pdf' ? '.pdf"' : '"') });
  res.end(m.data);
}
router.get('/chats/:id/media/:mid', async (req, res) => {
  const c = await db.prepare('SELECT id FROM chats WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!c) throw new HttpError(404, 'Conversation introuvable.');
  await sendMedia(req, res, c);
});

// Un humain écrit lui-même au client sur WhatsApp (l'IA se tait tant que la conversation n'est pas rendue) : seulement dans les 24 h après le dernier message du client.
async function replyToChat(org, user, chat, text) {
  if (chat.channel === 'web') throw new HttpError(400, "Seules les conversations WhatsApp, Messenger et Instagram permettent d'écrire au client depuis ici.");
  const wa = chat.channel === 'whatsapp';
  if (!(wa ? waOrg.isConnected(org) : metaChat.isConnected(org))) throw new HttpError(400, wa ? "WhatsApp n'est pas connecté." : "Messenger / Instagram n'est pas connecté.");
  const last = await db.prepare("SELECT created_at FROM chat_messages WHERE chat_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1").get(chat.id);
  if (!last || Date.now() - Date.parse(last.created_at) > 24 * 3600000) throw new HttpError(400, waOrg.modeOf(org) === 'qr' && wa ? "Plus de 24 h depuis le dernier message du client : pour protéger votre numéro, écrivez-lui seulement quand il vous a écrit récemment." : "Plus de 24 h depuis le dernier message du client : Meta n'autorise plus d'écrire librement. Attendez qu'il vous réécrive.");
  try { await (wa ? await waOrg.sendText(org, chat.contact, text) : await metaChat.sendText(org, chat.contact, text)); } catch (e) { throw new HttpError(502, "Le message n'a pas pu partir. Vérifiez la connexion dans les réglages."); }
  await db.prepare("INSERT INTO chat_messages (chat_id, role, content, created_at) VALUES (?, 'staff', ?, ?)").run(chat.id, text, nowISO());
  await db.prepare("UPDATE chats SET status = 'handoff', updated_at = ? WHERE id = ?").run(nowISO(), chat.id);
  await A.logActivity(org.id, user.id, 'sales', 'Réponse envoyée à un client');
}
router.post('/chats/:id/reply', asyncHandler(async (req, res) => {
  const c = await db.prepare('SELECT * FROM chats WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!c) throw new HttpError(404, 'Conversation introuvable.');
  await replyToChat(req.org, req.user, c, A.text((req.body || {}).text, 1000, { required: true, msg: 'Écrivez votre message.' }));
  res.json({ ok: true });
}));
// Attribuer la conversation à un membre de l'équipe (commercial) : il est prévenu (alerte, e-mail) et l'IA se tait. userId null = libérer.
router.put('/chats/:id/assign', async (req, res) => {
  const c = await db.prepare('SELECT * FROM chats WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!c) throw new HttpError(404, 'Conversation introuvable.');
  const uid = A.idOrNull((req.body || {}).userId, 'Personne invalide.');
  if (!await L.assign(req.org, c, uid, req.user.id)) throw new HttpError(400, "Cette personne ne fait pas partie de l'équipe.");
  res.json({ ok: true });
});
router.put('/chats/:id/status', async (req, res) => {
  const c = await db.prepare('SELECT * FROM chats WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!c) throw new HttpError(404, 'Conversation introuvable.');
  await db.prepare('UPDATE chats SET status = ? WHERE id = ?').run(A.oneOf((req.body || {}).status, ['open', 'handoff'], undefined, 'Statut inconnu.'), c.id);
  res.json({ ok: true });
});

// ---------- WhatsApp de l'organisation (API officielle de Meta) : réglages réservés aux administrateurs ----------
const waState = (o) => ({ connected: waOrg.isConnected(o), phoneId: o.wa_phone_id, wabaId: o.wa_waba || '', number: o.wa_number, tokenSet: Boolean(vault.decrypt(o.wa_token)), secretSet: Boolean(vault.decrypt(o.wa_secret)), verifyToken: o.wa_verify, webhookPath: `/api/ws/public/whatsapp/${o.intake_token}`, voice: stt.isConfigured() });
router.get('/whatsapp', A.need('admin'), (req, res) => res.json(waState(req.org)));
router.put('/whatsapp', A.need('admin'), async (req, res) => {
  const b = req.body || {};
  const o = req.org;
  if (b.phoneId !== undefined && String(b.phoneId).trim() && !/^\d{5,30}$/.test(String(b.phoneId).trim())) throw new HttpError(400, "L'identifiant du numéro (Phone number ID) doit contenir uniquement des chiffres (5 à 30).");
  const phoneId = b.phoneId === undefined ? o.wa_phone_id : String(b.phoneId).trim();
  if (false) throw new HttpError(400, "L'identifiant du numéro (Phone number ID) doit contenir uniquement des chiffres (5 à 30).");
  if (b.number !== undefined && /[A-Za-z]/.test(String(b.number))) throw new HttpError(400, 'Numéro WhatsApp invalide : chiffres uniquement, avec l\'indicatif du pays (237…).');
  const number = b.number === undefined ? o.wa_number : String(b.number).replace(/\D/g, '');
  if (number && (number.length < 8 || number.length > 15)) throw new HttpError(400, 'Numéro WhatsApp invalide : indiquez-le avec l\'indicatif du pays, par exemple 237677112233.');
  if (b.wabaId !== undefined && String(b.wabaId).trim() && !/^\d{5,30}$/.test(String(b.wabaId).trim())) throw new HttpError(400, "L'identifiant du compte WhatsApp Business doit contenir uniquement des chiffres (5 à 30).");
  const wabaId = b.wabaId === undefined ? (o.wa_waba || '') : String(b.wabaId).trim();
  if (phoneId && phoneId !== o.wa_phone_id && await db.prepare('SELECT id FROM orgs WHERE wa_phone_id = ? AND id <> ?').get(phoneId, o.id)) throw new HttpError(409, 'Ce numéro WhatsApp est déjà connecté à une autre organisation.');
  const token = b.token ? String(b.token).trim() : '';
  const secret = b.appSecret ? String(b.appSecret).trim() : '';
  if (token && (token.length < 20 || token.length > 600 || /\s/.test(token))) throw new HttpError(400, 'Jeton d\'accès invalide (copiez-le en entier depuis Meta, sans espace).');
  if (secret && (secret.length < 8 || secret.length > 200 || /\s/.test(secret))) throw new HttpError(400, "Secret de l'application invalide (copiez-le depuis Meta, sans espace).");
  await db.prepare('UPDATE orgs SET wa_phone_id = ?, wa_waba = ?, wa_number = ?, wa_token = ?, wa_secret = ?, wa_verify = ? WHERE id = ?').run(
    phoneId, wabaId, number, token ? vault.encrypt(token) : o.wa_token, secret ? vault.encrypt(secret) : o.wa_secret, o.wa_verify || crypto.randomBytes(12).toString('hex'), o.id);
  await A.logActivity(o.id, req.user.id, 'sales', 'Réglages WhatsApp mis à jour');
  res.json(waState(await db.prepare('SELECT * FROM orgs WHERE id = ?').get(o.id)));
});
router.post('/whatsapp/test', A.need('admin'), asyncHandler(async (req, res) => {
  if (!req.org.wa_phone_id || !vault.decrypt(req.org.wa_token)) throw new HttpError(400, "Enregistrez d'abord l'identifiant du numéro et le jeton d'accès.");
  try { res.json(await waOrg.profile(req.org)); } catch (e) { throw new HttpError(502, `Meta a refusé la connexion : ${oneLine(e.message.replace(/^.*HTTP \d+ : /, ''), 160)}`); }
}));
router.post('/whatsapp/subscribe', A.need('admin'), asyncHandler(async (req, res) => {
  if (!req.org.wa_waba || !vault.decrypt(req.org.wa_token)) throw new HttpError(400, "Enregistrez d'abord l'identifiant du compte WhatsApp Business et le jeton d'accès.");
  try { res.json(await waOrg.subscribeApp(req.org)); } catch (e) { throw new HttpError(502, `Meta a refusé l'abonnement : ${oneLine(e.message.replace(/^.*HTTP \d+ : /, ''), 160)}`); }
}));
router.delete('/whatsapp', A.need('admin'), async (req, res) => {
  await db.prepare("UPDATE orgs SET wa_phone_id = '', wa_waba = '', wa_token = '', wa_secret = '', wa_verify = '', wa_number = '' WHERE id = ?").run(req.org.id);
  await A.logActivity(req.org.id, req.user.id, 'sales', 'WhatsApp déconnecté');
  res.json({ ok: true });
});

// ---------- Connexion WhatsApp en un clic (Embedded Signup de Meta) : désactivée tant que les variables d'environnement manquent ----------
const graphVersion = () => (/\/(v\d+\.\d+)$/.exec(config.meta.graphUrl) || [])[1] || 'v21.0';
const metaReason = (e) => oneLine(String((e && e.message) || '').replace(/^.*HTTP \d+ : /, ''), 140);
router.get('/whatsapp/embedded/config', A.need('admin'), (req, res) => {
  if (!config.meta.embeddedEnabled) return res.json({ enabled: false });
  res.json({ enabled: true, appId: config.meta.appId, configId: config.meta.embeddedConfigId, graphVersion: graphVersion() });
});
const embeddedLimit = limits.make(10 * 60 * 1000, 20, 'Trop de tentatives. Réessayez dans quelques minutes.');
router.post('/whatsapp/embedded/complete', A.need('admin'), embeddedLimit, asyncHandler(async (req, res) => {
  if (!config.meta.embeddedEnabled) throw new HttpError(404, "La connexion en un clic n'est pas disponible sur ce serveur. Utilisez la saisie manuelle.");
  const b = req.body || {};
  const code = String(b.code || '').trim(); const phoneId = String(b.phoneNumberId || '').trim(); const wabaId = String(b.wabaId || '').trim();
  if (!/^\d{5,30}$/.test(phoneId)) throw new HttpError(400, "L'identifiant du numéro est invalide (chiffres uniquement, 5 à 30).");
  if (!/^\d{5,30}$/.test(wabaId)) throw new HttpError(400, "L'identifiant du compte WhatsApp Business est invalide (chiffres uniquement, 5 à 30).");
  if (code.length < 10 || code.length > 600 || /\s/.test(code)) throw new HttpError(400, 'Le code reçu de Meta est invalide. Recommencez la connexion.');
  const o = req.org;
  if (await db.prepare('SELECT id FROM orgs WHERE wa_phone_id = ? AND id <> ?').get(phoneId, o.id)) throw new HttpError(409, 'Ce numéro WhatsApp est déjà connecté à une autre organisation.');
  // (a) le code est échangé contre un jeton d'entreprise
  const q = new URLSearchParams({ client_id: config.meta.appId, client_secret: config.meta.appSecret, code });
  let token = '';
  try {
    const r = await fetchJson(`${config.meta.graphUrl}/oauth/access_token?${q.toString()}`);
    token = r.ok && r.data && typeof r.data.access_token === 'string' ? r.data.access_token : '';
    if (!token) throw new Error(`HTTP ${r.status} : ${(r.data && r.data.error && r.data.error.message) || 'réponse inattendue'}`);
  } catch (e) { throw new HttpError(502, `Meta a refusé le code de connexion (il expire vite) : ${metaReason(e)}. Recommencez.`); }
  const tmp = { wa_phone_id: phoneId, wa_waba: wabaId, wa_token: vault.encrypt(token), wa_secret: vault.encrypt(config.meta.appSecret) };
  // (b) enregistrement du numéro auprès de l'API Cloud : le code PIN est généré ici, jamais renvoyé ni journalisé
  try {
    const r = await fetchJson(`${config.meta.graphUrl}/${encodeURIComponent(phoneId)}/register`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: { messaging_product: 'whatsapp', pin: String(crypto.randomInt(100000, 1000000)) } });
    const msg = String((r.data && r.data.error && r.data.error.message) || '');
    if (!r.ok && !/already.{0,20}regist|d[ée]j[àa].{0,20}enregistr/i.test(msg)) throw new Error(`HTTP ${r.status} : ${msg || 'réponse inattendue'}`);
  } catch (e) { throw new HttpError(502, `Meta a refusé l'enregistrement du numéro : ${metaReason(e)}`); }
  // (c) abonnement de l'application au compte WhatsApp Business, (d) lecture du numéro affiché
  try { await waOrg.subscribeApp(tmp); } catch (e) { throw new HttpError(502, `Meta a refusé l'abonnement de l'application : ${metaReason(e)}`); }
  let prof;
  try { prof = await waOrg.profile(tmp); } catch (e) { throw new HttpError(502, `Impossible de lire le numéro auprès de Meta : ${metaReason(e)}`); }
  const number = prof.number.replace(/\D/g, '').slice(0, 15);
  // (e) tout est enregistré (jeton et secret chiffrés)
  await db.prepare('UPDATE orgs SET wa_phone_id = ?, wa_waba = ?, wa_number = ?, wa_token = ?, wa_secret = ?, wa_verify = ? WHERE id = ?').run(
    phoneId, wabaId, number, tmp.wa_token, tmp.wa_secret, crypto.randomBytes(12).toString('hex'), o.id);
  await A.logActivity(o.id, req.user.id, 'sales', 'WhatsApp connecté en un clic');
  res.json({ ok: true, ...waState(await db.prepare('SELECT * FROM orgs WHERE id = ?').get(o.id)) });
}));

// ---------- Commandes des clients (à valider) ----------
router.get('/orders', async (req, res) => {
  const rows = await db.prepare("SELECT d.*, c.name AS customer, c.phone, c.email FROM documents d JOIN customers c ON c.id = d.customer_id WHERE d.org_id = ? AND d.kind = 'order' ORDER BY CASE d.status WHEN 'pending' THEN 0 ELSE 1 END, d.id DESC LIMIT 100").all(req.org.id);
  const ids = rows.filter((d) => Number(d.negotiated)).map((d) => d.id);
  const logs = {};
  for (const id of ids) logs[id] = await N.logOfDoc(req.org.id, id);
  res.json({ orders: rows.map((d) => ({ id: d.id, number: d.number, status: d.status, total: d.total, note: d.note, lines: JSON.parse(d.lines), customer: d.customer, customerId: d.customer_id, phone: d.phone, email: d.email, at: d.created_at, negotiated: Boolean(d.negotiated), discountPct: Number(d.discount_pct) || 0, approval: d.approval || '', decisionId: d.decision_id || null, negotiation: logs[d.id] || [] })) });
});
const orderOf = async (req) => {
  const d = await db.prepare("SELECT * FROM documents WHERE id = ? AND org_id = ? AND kind = 'order'").get(A.id(req.params.id), req.org.id);
  if (!d) throw new HttpError(404, 'Commande introuvable.');
  return d;
};
router.put('/orders/:id/status', async (req, res) => {
  const d = await orderOf(req);
  const st = A.oneOf((req.body || {}).status, ['confirmed', 'cancelled'], undefined, 'Statut inconnu.');
  if (d.status !== 'pending') throw new HttpError(400, 'Cette commande a déjà été traitée.');
  if (st === 'confirmed' && ['needed', 'rejected'].includes(d.approval)) throw new HttpError(409, d.approval === 'needed' ? `Cette commande a une remise de ${Number(d.discount_pct)} % au-dessus du seuil : elle doit d'abord être validée dans « Décisions » par un responsable.` : 'La remise de cette commande a été refusée : refusez la commande ou négociez avec le client.');
  await db.prepare('UPDATE documents SET status = ?, updated_at = ? WHERE id = ?').run(st, nowISO(), d.id);
  if (d.negotiated) await N.log(req.org.id, { docId: d.id, chatId: d.chat_id, label: d.number, actor: 'human', kind: st === 'confirmed' ? 'confirmed' : 'cancelled', userId: req.user.id, note: `commande ${st === 'confirmed' ? 'confirmée' : 'refusée'} par l'équipe` });
  await A.logActivity(req.org.id, req.user.id, 'sales', `Commande ${d.number} ${st === 'confirmed' ? 'confirmée' : 'refusée'}`);
  res.json({ ok: true });
});
// Commande confirmée → facture (brouillon) avec les mêmes lignes.
router.post('/orders/:id/invoice', async (req, res) => {
  const d = await orderOf(req);
  if (d.status !== 'confirmed') throw new HttpError(400, "Confirmez d'abord la commande.");
  const id = await crm.createDoc(req, { customerId: d.customer_id, lines: JSON.parse(d.lines), note: `Suite à la commande ${d.number}`, due: (req.body || {}).due }, 'invoice', { skipFloor: true });
  await db.prepare("UPDATE documents SET status = 'invoiced', updated_at = ? WHERE id = ?").run(nowISO(), d.id);
  res.status(201).json({ id });
});

// ---------- Campagnes : de la conversation à la commande ----------
router.get('/campaigns', async (req, res) => {
  const rows = await db.prepare(`SELECT CASE WHEN c.campaign = '' THEN '(sans campagne)' ELSE c.campaign END AS campaign, COUNT(*) AS chats,
      COUNT(DISTINCT c.customer_id) AS prospects,
      COUNT(DISTINCT (SELECT d.id FROM documents d WHERE d.chat_id = c.id AND d.kind = 'order' AND d.status != 'cancelled' LIMIT 1)) AS ordered,
      COALESCE(SUM((SELECT COALESCE(SUM(d.total), 0) FROM documents d WHERE d.chat_id = c.id AND d.kind = 'order' AND d.status != 'cancelled')), 0) AS amount
    FROM chats c WHERE c.org_id = ? GROUP BY c.campaign ORDER BY chats DESC LIMIT 30`).all(req.org.id);
  res.json({ campaigns: rows });
});

// ---------- « Mes conversations » : tout membre de l'équipe voit et traite SEULEMENT les conversations qui lui sont attribuées ----------
const mine = express.Router({ mergeParams: true });
const mineChat = async (req) => {
  const c = await db.prepare('SELECT * FROM chats WHERE id = ? AND org_id = ? AND assignee_id = ?').get(A.id(req.params.id), req.org.id, req.user.id);
  if (!c) throw new HttpError(404, "Cette conversation ne vous est pas attribuée.");
  return c;
};
mine.get('/chats', async (req, res) => {
  const rows = await db.prepare(`SELECT c.id, c.campaign, c.status, c.channel, c.contact, c.updated_at, c.lead, cu.name AS customer, cu.phone, cu.stage,
      (SELECT content FROM chat_messages m WHERE m.chat_id = c.id AND m.role = 'user' ORDER BY m.id DESC LIMIT 1) AS lastText
    FROM chats c LEFT JOIN customers cu ON cu.id = c.customer_id WHERE c.org_id = ? AND c.assignee_id = ? ORDER BY c.updated_at DESC LIMIT 60`).all(req.org.id, req.user.id);
  res.json({ chats: rows.map((r) => ({ id: r.id, campaign: r.campaign, status: r.status, channel: r.channel, contact: r.contact, at: r.updated_at, customer: r.customer, phone: r.phone, stage: r.stage, lastText: r.lastText, temperature: L.cleanLead(JSON.parse(r.lead || '{}')).temperature || null })) });
});
mine.get('/chats/:id', async (req, res) => {
  const c = await mineChat(req);
  res.json({ campaign: c.campaign, status: c.status, channel: c.channel, contact: c.contact, assigneeId: c.assignee_id, lead: L.cleanLead(JSON.parse(c.lead || '{}')), summary: L.leadSummary(c.lead), brief: B.read(c), appointments: await db.prepare("SELECT id, date, time, purpose, status FROM appointments WHERE chat_id = ? ORDER BY id DESC LIMIT 5").all(c.id), negotiation: await N.logOfChat(req.org.id, c.id), messages: await db.prepare('SELECT role, content, created_at AS at FROM chat_messages WHERE chat_id = ? ORDER BY id LIMIT 200').all(c.id) });
});
mine.get('/chats/:id/media/:mid', async (req, res) => await sendMedia(req, res, await mineChat(req)));
mine.post('/chats/:id/apply-brief', async (req, res) => { res.json({ ok: true, done: await B.apply(req.org, await mineChat(req)) }); });
mine.post('/chats/:id/reply', asyncHandler(async (req, res) => {
  await replyToChat(req.org, req.user, await mineChat(req), A.text((req.body || {}).text, 1000, { required: true, msg: 'Écrivez votre message.' }));
  res.json({ ok: true });
}));
mine.post('/chats/:id/release', async (req, res) => { await L.assign(req.org, await mineChat(req), null, req.user.id); res.json({ ok: true }); }); // rendre la conversation à l'équipe
mine.put('/chats/:id/status', async (req, res) => {
  const c = await mineChat(req);
  await db.prepare('UPDATE chats SET status = ? WHERE id = ?').run(A.oneOf((req.body || {}).status, ['open', 'handoff'], undefined, 'Statut inconnu.'), c.id);
  res.json({ ok: true });
});

module.exports = { router, mine };
