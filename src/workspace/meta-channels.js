'use strict';
// Messenger (Page Facebook) et Instagram (compte professionnel) d'UNE organisation : le même assistant commercial répond aux messages privés.
// Webhook : /api/ws/public/meta/<jeton de l'organisation>. Signature X-Hub-Signature-256 vérifiée avec le « secret de l'application » (corps brut).
// Réglages (administrateurs) : routes montées dans la sous-application « Assistant commercial ».
const crypto = require('crypto');
const express = require('express');
const { db } = require('../db');
const A = require('./access');
const vault = require('../services/vault');
const metaChat = require('../services/metaChat');
const inbound = require('./inbound');
const stt = require('../services/stt');
const { HttpError, asyncHandler, safeEqual, log, makeSeen, oneLine, cleanText } = require('../util');

const seen = makeSeen();
const hits = new Map();
const NOT_TEXT = "Je peux lire les messages écrits et les messages vocaux, ainsi que les photos et les PDF. Pouvez-vous m'écrire votre demande ?";
const CANT_OPEN = "Je n'ai pas pu ouvrir votre fichier. Pouvez-vous le renvoyer ou m'écrire votre demande ?";
const orgOf = async (token) => await db.prepare('SELECT * FROM orgs WHERE intake_token = ?').get(String(token || '').slice(0, 80));

function tooMany(key) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < 600000);
  arr.push(now); hits.set(key, arr);
  if (hits.size > 5000) hits.clear();
  return arr.length > 25;
}
function validSignature(req, secret) {
  const header = req.get('x-hub-signature-256') || '';
  if (!secret || !req.rawBody || !header.startsWith('sha256=')) return false;
  const a = Buffer.from(crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex'), 'utf8');
  const b = Buffer.from(header.slice(7), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------- Webhook public ----------
const hook = express.Router();
hook.get('/:token', async (req, res) => {
  const org = await orgOf(req.params.token);
  if (!org || !org.fb_verify || req.query['hub.mode'] !== 'subscribe' || !safeEqual(String(req.query['hub.verify_token'] || ''), org.fb_verify)) return res.status(403).type('text/plain').send('Vérification refusée');
  return res.status(200).type('text/plain').send(String(req.query['hub.challenge'] || ''));
});
hook.post('/:token', express.json({ limit: '1mb', verify: (req, res, buf) => { req.rawBody = buf; } }), async (req, res) => {
  const org = await orgOf(req.params.token);
  if (!org || !metaChat.isConnected(org)) return res.status(404).json({ error: 'Introuvable.' });
  if (!validSignature(req, vault.decrypt(org.fb_secret))) { log.warn(`Messenger/Instagram (organisation ${org.id}) : signature invalide, message rejeté.`); require('../security').abuse.strike(req, 'bad_signature'); return res.status(403).json({ error: 'Signature invalide.' }); }
  res.status(200).send('EVENT_RECEIVED');
  const body = req.body;
  setImmediate(async () => processBody(org, body).catch((e) => log.warn(`Messenger/Instagram (organisation ${org.id}) : erreur de traitement :`, oneLine(e.message, 200))));
});

async function processBody(org, body) {
  if (!body || !['page', 'instagram'].includes(body.object)) return;
  const channel = body.object === 'page' ? 'messenger' : 'instagram';
  for (const entry of body.entry || []) {
    if (String(entry.id) !== String(channel === 'messenger' ? org.fb_page_id : org.ig_id)) continue; // pas notre Page / notre compte
    for (const ev of entry.messaging || []) {
      try { await handle(org, channel, ev); } catch (e) { log.warn('Messenger/Instagram : message non traité :', oneLine(e.message, 200)); }
    }
  }
}

async function handle(org, channel, ev) {
  const m = ev && ev.message;
  if (!m || m.is_echo || !ev.sender || !m.mid || seen(`${org.id}:${m.mid}`)) return;
  const from = String(ev.sender.id || '').replace(/\D/g, '');
  if (!from || from.length > 30 || from === String(org.fb_page_id) || from === String(org.ig_id)) return;
  if (tooMany(`${org.id}:${channel}:${from}`)) return;
  let text = typeof m.text === 'string' ? cleanText(m.text, 1000) : '';
  let viaVoice = false; let attachment = null;
  if (!text) {
    const a = (Array.isArray(m.attachments) ? m.attachments : [])[0];
    const url = a && a.payload && a.payload.url;
    if (!a || !url || !['audio', 'image', 'file'].includes(a.type)) return void (await metaChat.sendText(org, from, NOT_TEXT));
    let buf;
    try { buf = await metaChat.downloadUrl(url); } catch (e) { log.warn('Messenger/Instagram : pièce jointe illisible :', oneLine(e.message, 160)); return void (await metaChat.sendText(org, from, CANT_OPEN)); }
    if (a.type === 'audio') {
      if (!stt.isConfigured()) return void (await metaChat.sendText(org, from, NOT_TEXT));
      try { text = cleanText(await stt.transcribe(buf), 1000); viaVoice = true; } catch (e) { log.warn('Messenger/Instagram : message vocal illisible :', oneLine(e.message, 160)); }
      if (!text) return void (await metaChat.sendText(org, from, "Je n'ai pas pu comprendre votre message vocal. Pouvez-vous le réécrire ou le renvoyer ?"));
    } else attachment = buf;
  }
  let campaign = '';
  const tag = /#([A-Za-z0-9_-]{2,40})/.exec(text);
  if (tag) { campaign = tag[1]; text = cleanText(text.replace(tag[0], ''), 1000) || 'Bonjour'; }
  await inbound.receive(org, channel, from, { campaign, text, viaVoice, attachment });
}

// ---------- Réglages (administrateurs) ----------
const settings = express.Router({ mergeParams: true });
const state = (o) => ({ connected: metaChat.isConnected(o), pageId: o.fb_page_id, instagramId: o.ig_id, tokenSet: Boolean(vault.decrypt(o.fb_token)), secretSet: Boolean(vault.decrypt(o.fb_secret)), verifyToken: o.fb_verify, webhookPath: `/api/ws/public/meta/${o.intake_token}` });
settings.get('/', A.need('admin'), (req, res) => res.json(state(req.org)));
settings.put('/', A.need('admin'), async (req, res) => {
  const b = req.body || {}; const o = req.org;
  const num = (v, cur, what) => { if (v === undefined) return cur; const t = String(v).trim(); if (t && !/^\d{5,30}$/.test(t)) throw new HttpError(400, `${what} : chiffres uniquement (5 à 30).`); return t; };
  const pageId = num(b.pageId, o.fb_page_id, 'Identifiant de la Page'); const igId = num(b.instagramId, o.ig_id, "Identifiant du compte Instagram");
  const token = b.token ? String(b.token).trim() : ''; const secret = b.appSecret ? String(b.appSecret).trim() : '';
  if (token && (token.length < 20 || token.length > 800 || /\s/.test(token))) throw new HttpError(400, "Jeton d'accès invalide (copiez-le en entier depuis Meta, sans espace).");
  if (secret && (secret.length < 8 || secret.length > 200 || /\s/.test(secret))) throw new HttpError(400, "Secret de l'application invalide (copiez-le depuis Meta, sans espace).");
  await db.prepare('UPDATE orgs SET fb_page_id = ?, ig_id = ?, fb_token = ?, fb_secret = ?, fb_verify = ? WHERE id = ?').run(pageId, igId, token ? vault.encrypt(token) : o.fb_token, secret ? vault.encrypt(secret) : o.fb_secret, o.fb_verify || crypto.randomBytes(12).toString('hex'), o.id);
  await A.logActivity(o.id, req.user.id, 'sales', 'Réglages Messenger / Instagram mis à jour');
  res.json(state(await db.prepare('SELECT * FROM orgs WHERE id = ?').get(o.id)));
});
settings.post('/test', A.need('admin'), asyncHandler(async (req, res) => {
  if (!metaChat.isConnected(req.org)) throw new HttpError(400, "Renseignez d'abord l'identifiant de la Page, le jeton et le secret de l'application.");
  try { res.json(await metaChat.profile(req.org)); } catch (e) { throw new HttpError(502, `Meta a refusé la connexion : ${oneLine(e.message.replace(/^.*HTTP \d+ : /, ''), 160)}`); }
}));
settings.delete('/', A.need('admin'), async (req, res) => {
  await db.prepare("UPDATE orgs SET fb_page_id = '', ig_id = '', fb_token = '', fb_secret = '', fb_verify = '' WHERE id = ?").run(req.org.id);
  res.json({ ok: true });
});

module.exports = hook;
module.exports.settings = settings;
module.exports.processBody = processBody;
