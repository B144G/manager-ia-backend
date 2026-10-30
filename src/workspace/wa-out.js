'use strict';
// Messages WhatsApp sortants : modèles approuvés par Meta, relances des prospects silencieux, rappels de factures impayées.
// Règles : jamais à quelqu'un qui a écrit « STOP », jamais plus d'un envoi par prospect (relance) ni par semaine et par facture,
// plafond quotidien par organisation, et uniquement vers des personnes déjà en contact (conversation WhatsApp ou fiche client).
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const waOrg = require('../services/waOrg');
const { amap, afilter, HttpError, asyncHandler, oneLine, log } = require('../util');

const DAY_CAP = 200;
const digits = (x) => String(x || '').replace(/\D/g, '');
const CC = String(process.env.DEFAULT_COUNTRY_CODE || '237').replace(/\D/g, '');
/** Numéro au format international pour Meta : un numéro local à 9 chiffres (ex. 655 12 34 56) reçoit l'indicatif du pays (Cameroun par défaut). */
const intl = (x) => { let d = digits(x); if (d.startsWith('00')) d = d.slice(2); return d.length === 9 && /^[2368]/.test(d) ? CC + d : d; };
// Nombre de variables du modèle selon l'usage : le texte du modèle est écrit dans Meta avec {{1}}, {{2}}…
const PURPOSES = {
  relance: { label: 'Relance d\'un prospect', params: 2, hint: '{{1}} = prénom du client, {{2}} = nom de votre entreprise', example: 'Bonjour {{1}}, c\'est {{2}}. Vous nous avez écrit récemment : êtes-vous toujours intéressé ? Répondez-nous ici, nous restons à votre disposition.' },
  impaye: { label: 'Rappel de facture impayée', params: 4, hint: '{{1}} = prénom du client, {{2}} = numéro de facture, {{3}} = reste à payer, {{4}} = nom de votre entreprise', example: 'Bonjour {{1}}, la facture {{2}} (reste à payer : {{3}}) est arrivée à échéance. Merci de régler dès que possible. {{4}}' },
  rdv: { label: 'Rappel de rendez-vous', params: 4, hint: '{{1}} = prénom du client, {{2}} = jour et date, {{3}} = heure, {{4}} = nom de votre entreprise', example: 'Bonjour {{1}}, rappel : votre rendez-vous est prévu {{2}} à {{3}} chez {{4}}. Répondez à ce message si vous devez le déplacer.' },
  general: { label: 'Autre message', params: null, hint: 'Variables libres, remplies à l\'envoi', example: '' },
};
const render = (preview, params) => String(preview || '').replace(/\{\{(\d+)\}\}/g, (m, n) => (params[Number(n) - 1] !== undefined ? params[Number(n) - 1] : m));
const firstName = (n) => String(n || '').trim().split(/\s+/)[0] || 'Madame, Monsieur';
const isOptedOut = async (orgId, phone) => Boolean(await db.prepare('SELECT 1 FROM wa_optout WHERE org_id = ? AND phone = ?').get(orgId, digits(phone)));
const optOut = async (orgId, phone) => await db.prepare('INSERT OR IGNORE INTO wa_optout (org_id, phone, at) VALUES (?, ?, ?)').run(orgId, digits(phone), nowISO());
const optIn = async (orgId, phone) => await db.prepare('DELETE FROM wa_optout WHERE org_id = ? AND phone = ?').run(orgId, digits(phone));
const sentToday = async (orgId) => (await db.prepare("SELECT COUNT(*) c FROM wa_outbound WHERE org_id = ? AND status = 'sent' AND created_at >= ?").get(orgId, new Date(Date.now() - 86400000).toISOString())).c;

/** Envoie un modèle. Journalise toujours. Renvoie { ok, error }. Si chat est fourni, le message apparaît dans la conversation. */
async function sendTemplate(org, { phone, tpl, params, chat, refKind, refId }) {
  const to = intl(phone);
  const log1 = async (status, error) => await db.prepare('INSERT INTO wa_outbound (org_id, chat_id, ref_kind, ref_id, phone, template, status, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(org.id, chat ? chat.id : null, refKind || '', refId || null, to, tpl.name, status, error || '', nowISO());
  if (!waOrg.isConnected(org)) return { ok: false, error: "WhatsApp n'est pas connecté." };
  if (waOrg.modeOf(org) === 'qr') return { ok: false, error: "Les modèles de message ne sont pas disponibles avec la connexion par QR code (envoi non sollicité évité pour protéger votre numéro)." };
  if (to.length < 8 || to.length > 15) return { ok: false, error: 'Numéro de téléphone invalide.' };
  if (await isOptedOut(org.id, to)) return { ok: false, error: 'Cette personne a demandé à ne plus recevoir de messages.' };
  if (await sentToday(org.id) >= DAY_CAP) return { ok: false, error: `Plafond de ${DAY_CAP} messages sortants par 24 h atteint.` };
  try {
    await waOrg.sendTemplate(org, to, tpl.name, tpl.language, params);
  } catch (e) {
    const msg = oneLine(String(e.message).replace(/^.*HTTP \d+ : /, ''), 160);
    await log1('failed', msg);
    return { ok: false, error: `Meta a refusé l'envoi : ${msg}` };
  }
  await log1('sent', '');
  if (chat) await db.prepare("INSERT INTO chat_messages (chat_id, role, content, created_at) VALUES (?, 'staff', ?, ?)").run(chat.id, `[modèle ${tpl.name}] ${render(tpl.preview, params)}`.slice(0, 2000), nowISO());
  return { ok: true };
}

const tplOf = async (orgId, purpose) => await db.prepare('SELECT * FROM wa_templates WHERE org_id = ? AND purpose = ? ORDER BY id LIMIT 1').get(orgId, purpose);

/** Prospects WhatsApp silencieux : le client a écrit il y a plus de 24 h (et moins de 7 jours), l'IA n'a pas conclu, jamais relancé. */
async function silentLeads(org) {
  const lo = new Date(Date.now() - 7 * 86400000).toISOString(); const hi = new Date(Date.now() - 24 * 3600000).toISOString();
  return afilter(await db.prepare(`SELECT c.id, c.contact, c.updated_at, cu.name AS customer,
      (SELECT created_at FROM chat_messages m WHERE m.chat_id = c.id AND m.role = 'user' ORDER BY m.id DESC LIMIT 1) AS lastUser
    FROM chats c LEFT JOIN customers cu ON cu.id = c.customer_id
    WHERE c.org_id = ? AND c.channel = 'whatsapp' AND c.status = 'open' AND c.assignee_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.chat_id = c.id)
      AND NOT EXISTS (SELECT 1 FROM wa_outbound o WHERE o.org_id = c.org_id AND o.ref_kind = 'chat' AND o.ref_id = c.id AND o.status = 'sent')
    ORDER BY c.updated_at DESC LIMIT 200`).all(org.id), async (r) => r.lastUser && r.lastUser < hi && r.lastUser > lo && !(await isOptedOut(org.id, r.contact)));
}
/** Factures échues avec un numéro de téléphone, sans rappel WhatsApp depuis 7 jours. */
async function overdueInvoices(org) {
  const since = new Date(Date.now() - 7 * 86400000).toISOString();
  return afilter(await db.prepare(`SELECT d.id, d.number, d.total, d.paid, d.credited, d.due, c.name AS customer, c.phone
    FROM documents d JOIN customers c ON c.id = d.customer_id
    WHERE d.org_id = ? AND d.kind = 'invoice' AND d.status = 'sent' AND d.due IS NOT NULL AND d.due < ? AND d.paid < d.total - d.credited AND c.phone != ''
      AND NOT EXISTS (SELECT 1 FROM wa_outbound o WHERE o.org_id = d.org_id AND o.ref_kind = 'invoice' AND o.ref_id = d.id AND o.status = 'sent' AND o.created_at > ?)
    ORDER BY d.due LIMIT 200`).all(org.id, nowISO().slice(0, 10), since), async (r) => !(await isOptedOut(org.id, r.phone)));
}

async function sendLead(org, tpl, lead) {
  const chat = await db.prepare('SELECT * FROM chats WHERE id = ?').get(lead.id);
  return await sendTemplate(org, { phone: lead.contact, tpl, params: [firstName(lead.customer), org.name], chat, refKind: 'chat', refId: lead.id });
}
async function sendInvoice(org, tpl, inv) {
  const left = `${(inv.total - inv.credited - inv.paid).toLocaleString('fr-FR')} ${org.currency}`;
  return await sendTemplate(org, { phone: inv.phone, tpl, params: [firstName(inv.customer), inv.number, left, org.name], refKind: 'invoice', refId: inv.id });
}

/** Relances automatiques (appelées chaque heure pour les organisations qui les ont activées). */
async function runAuto(org, max = 20) {
  if (!org.wa_followup || !waOrg.isConnected(org) || waOrg.modeOf(org) === 'qr') return 0;
  const fu = await db.prepare("SELECT mode FROM fu_settings WHERE org_id = ?").get(org.id);
  if (fu && fu.mode === 'auto') return 0; // le centre de relances (followups.js) en mode automatique prend le relais : pas de doublon
  let n = 0;
  const t1 = await tplOf(org.id, 'relance'); const t2 = await tplOf(org.id, 'impaye');
  if (t1) for (const l of await silentLeads(org)) { if (n >= max) break; const r = await sendLead(org, t1, l); if (r.ok) n++; else if (/Plafond|connecté/.test(r.error)) return n; }
  if (t2) for (const i of await overdueInvoices(org)) { if (n >= max) break; const r = await sendInvoice(org, t2, i); if (r.ok) n++; else if (/Plafond|connecté/.test(r.error)) return n; }
  if (n) log.info(`Relances WhatsApp automatiques : ${n} message(s) pour l'organisation ${org.id}.`);
  return n;
}
async function runAllAuto() {
  for (const org of await db.prepare('SELECT * FROM orgs WHERE wa_followup = 1').all()) { try { await runAuto(org); } catch (e) { log.warn('Relances WhatsApp :', oneLine(e.message, 160)); } }
}

// ---------- Routes (montées dans la sous-application « Assistant commercial » : responsables et plus) ----------
const router = express.Router({ mergeParams: true });
const tplView = (t) => ({ id: t.id, name: t.name, language: t.language, purpose: t.purpose, params: t.params, preview: t.preview });

router.get('/', async (req, res) => {
  const o = req.org;
  res.json({
    connected: waOrg.isConnected(o), mode: waOrg.modeOf(o), autoFollowup: Boolean(o.wa_followup), purposes: Object.fromEntries(Object.entries(PURPOSES).map(([k, v]) => [k, { label: v.label, params: v.params, hint: v.hint, example: v.example }])),
    templates: (await db.prepare('SELECT * FROM wa_templates WHERE org_id = ? ORDER BY id').all(o.id)).map(tplView),
    silent: (await silentLeads(o)).map((l) => ({ id: l.id, name: l.customer || '', contact: l.contact, lastAt: l.lastUser })),
    overdue: (await overdueInvoices(o)).map((i) => ({ id: i.id, number: i.number, customer: i.customer, phone: i.phone, left: i.total - i.credited - i.paid, due: i.due })),
    sentToday: await sentToday(o.id), dayCap: DAY_CAP,
    log: await db.prepare('SELECT id, chat_id AS chatId, phone, template, status, error, created_at AS at FROM wa_outbound WHERE org_id = ? ORDER BY id DESC LIMIT 30').all(o.id),
    optouts: (await db.prepare('SELECT COUNT(*) c FROM wa_optout WHERE org_id = ?').get(o.id)).c,
  });
});

router.post('/templates', A.need('admin'), async (req, res) => {
  const b = req.body || {};
  const purpose = A.oneOf(b.purpose, Object.keys(PURPOSES), 'general', 'Usage inconnu.');
  const name = A.text(b.name, 80, { required: true, msg: 'Indiquez le nom du modèle, exactement comme dans Meta.' });
  if (!/^[a-z0-9_]{1,80}$/.test(name)) throw new HttpError(400, 'Le nom d\'un modèle Meta ne contient que des minuscules, chiffres et « _ » (ex. relance_prospect).');
  const language = A.text(b.language, 10) || 'fr';
  if (!/^[a-z]{2}(_[A-Z]{2})?$/.test(language)) throw new HttpError(400, 'Langue invalide (ex. fr ou fr_FR).');
  const preview = A.text(b.preview, 1000);
  const fixed = PURPOSES[purpose].params;
  const found = new Set((preview.match(/\{\{(\d+)\}\}/g) || [])).size;
  const params = fixed === null ? Math.min(found, 8) : fixed;
  if (fixed !== null && preview && found !== fixed) throw new HttpError(400, `Ce type de modèle utilise exactement ${fixed} variable(s) : ${PURPOSES[purpose].hint}.`);
  try {
    const id = (await db.prepare('INSERT INTO wa_templates (org_id, name, language, purpose, params, preview, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(req.org.id, name, language, purpose, params, preview, nowISO())).lastInsertRowid;
    res.status(201).json({ id: Number(id) });
  } catch (e) { if (e.code === '23505') throw new HttpError(409, 'Un modèle avec ce nom et cette langue existe déjà.'); throw e; }
});
router.delete('/templates/:id', A.need('admin'), async (req, res) => {
  await db.prepare('DELETE FROM wa_templates WHERE id = ? AND org_id = ?').run(A.id(req.params.id), req.org.id);
  res.json({ ok: true });
});
router.put('/auto', A.need('admin'), async (req, res) => {
  await db.prepare('UPDATE orgs SET wa_followup = ? WHERE id = ?').run((req.body || {}).enabled ? 1 : 0, req.org.id);
  res.json({ ok: true });
});

// Écrire à une conversation plus de 24 h après le dernier message du client : par modèle.
router.post('/chats/:id/template', asyncHandler(async (req, res) => {
  const chat = await db.prepare('SELECT * FROM chats WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!chat || chat.channel !== 'whatsapp') throw new HttpError(404, 'Conversation WhatsApp introuvable.');
  const tpl = await db.prepare('SELECT * FROM wa_templates WHERE id = ? AND org_id = ?').get(A.id((req.body || {}).templateId), req.org.id);
  if (!tpl) throw new HttpError(404, 'Modèle introuvable.');
  const params = (Array.isArray((req.body || {}).params) ? req.body.params : []).slice(0, 8).map((x) => String(x == null ? '' : x).slice(0, 300));
  if (tpl.params && params.length !== tpl.params) throw new HttpError(400, `Ce modèle attend ${tpl.params} variable(s).`);
  const r = await sendTemplate(req.org, { phone: chat.contact, tpl, params, chat, refKind: 'chat-manual', refId: chat.id });
  if (!r.ok) throw new HttpError(400, r.error);
  await A.logActivity(req.org.id, req.user.id, 'sales', 'Modèle WhatsApp envoyé à un prospect');
  res.json({ ok: true });
}));

// Envoi immédiat des relances (prospects silencieux ou factures impayées), au plus 50 à la fois.
router.post('/send', A.need('admin'), asyncHandler(async (req, res) => {
  const kind = A.oneOf((req.body || {}).kind, ['relance', 'impaye'], undefined, 'Type inconnu.');
  const tpl = await tplOf(req.org.id, kind);
  if (!tpl) throw new HttpError(400, `Ajoutez d'abord un modèle « ${PURPOSES[kind].label} » (approuvé par Meta).`);
  let sent = 0; const errors = [];
  const list = (kind === 'relance' ? await silentLeads(req.org) : await overdueInvoices(req.org)).slice(0, 50);
  for (const x of list) {
    const r = kind === 'relance' ? await sendLead(req.org, tpl, x) : await sendInvoice(req.org, tpl, x);
    if (r.ok) sent++; else { errors.push(r.error); if (/Plafond|connecté/.test(r.error)) break; }
  }
  await A.logActivity(req.org.id, req.user.id, 'sales', `${sent} relance(s) WhatsApp envoyée(s)`);
  res.json({ sent, failed: errors.length, error: errors[0] || '' });
}));

module.exports = { router, sendTemplate, tplOf, firstName, runAuto, runAllAuto, isOptedOut, optOut, optIn, render, PURPOSES, silentLeads, overdueInvoices };
