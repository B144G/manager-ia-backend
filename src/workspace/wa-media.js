'use strict';
// Photos et vidéos des articles du catalogue : stockage (images 3 Mo, vidéos 16 Mo, 8 fichiers par article, 80 Mo par organisation),
// et envoi aux clients par WhatsApp. Le type du fichier est reconnu d'après son contenu, jamais d'après son nom.
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const limits = require('../middleware/limits');
const waOrg = require('../services/waOrg');
const channels = require('./channels');
const { HttpError, asyncHandler, cleanText, oneLine, log } = require('../util');

const MAX_IMG = 3 * 1024 * 1024; const MAX_VID = 16 * 1024 * 1024; const MAX_PER_ITEM = 8; const MAX_ORG = 80 * 1024 * 1024;
const TTL = 25 * 86400000;                 // l'identifiant Meta d'un fichier vit 30 jours : on le réutilise 25 jours
const PER_TURN = { image: 3, video: 1 };   // au plus 3 photos et 1 vidéo par réponse de l'IA
const PER_DAY = 40;                        // fichiers envoyés à une même personne en 24 h

function sniff(b) {
  if (!b || b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { kind: 'image', mime: 'image/jpeg' };
  if (b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { kind: 'image', mime: 'image/png' };
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return { kind: 'image', mime: 'image/webp' };
  if (b.toString('latin1', 4, 8) === 'ftyp') return { kind: 'video', mime: 'video/mp4' };
  return null;
}
const metaOf = (m) => ({ id: m.id, kind: m.kind, mime: m.mime, size: m.size, name: m.name });
const mediaFor = (itemId) => db.prepare('SELECT * FROM catalog_media WHERE item_id = ? ORDER BY id').all(itemId);

/** Identifiant Meta du fichier (envoyé à Meta si besoin). */
async function metaId(org, m) {
  const fresh = m.wa_media_id && m.wa_phone_id === org.wa_phone_id && m.wa_media_at && Date.now() - Date.parse(m.wa_media_at) < TTL;
  if (fresh) return m.wa_media_id;
  const id = await waOrg.uploadMedia(org, m.data, m.mime, `${m.kind}-${m.id}.${m.mime === 'video/mp4' ? 'mp4' : m.mime.split('/')[1]}`);
  db.prepare('UPDATE catalog_media SET wa_media_id = ?, wa_phone_id = ?, wa_media_at = ? WHERE id = ?').run(id, org.wa_phone_id, nowISO(), m.id);
  return id;
}

/** Envoie les photos et vidéos d'un article. kind : 'image', 'video' ou 'all'. Renvoie { sent, images, videos }. */
async function sendItem(org, chat, item, kind) {
  const to = chat.contact;
  const all = mediaFor(item.id).filter((m) => kind === 'all' || m.kind === kind);
  const picks = [...all.filter((m) => m.kind === 'image').slice(0, PER_TURN.image), ...all.filter((m) => m.kind === 'video').slice(0, PER_TURN.video)];
  const out = { sent: 0, images: 0, videos: 0 };
  const day = db.prepare("SELECT COUNT(*) c FROM chat_messages WHERE chat_id = ? AND role = 'assistant' AND content LIKE '[fichier envoyé%' AND created_at > ?").get(chat.id, new Date(Date.now() - 86400000).toISOString()).c;
  for (const m of picks) {
    if (day + out.sent >= PER_DAY) break;
    const caption = out.sent === 0 ? `${item.name} · ${Number(item.price).toLocaleString('fr-FR')} ${org.currency}${item.unit ? ' / ' + item.unit : ''}` : '';
    if (chat.channel === 'whatsapp') await waOrg.sendMedia(org, to, m.kind, await metaId(org, m), caption);
    else {
      if (caption) await channels.sendText(org, chat, caption); // Messenger et Instagram : pas de légende sur un fichier, on l'écrit juste avant
      await channels.sendCatalogLink(org, chat, m);
    }
    out.sent++; if (m.kind === 'image') out.images++; else out.videos++;
  }
  return out;
}

/** Envoie ce que l'IA a demandé (liste { itemId, kind }) et note l'envoi dans la conversation. Ne lance jamais d'erreur. */
async function sendForChat(org, chat, wanted) {
  const notes = [];
  for (const w of (wanted || []).slice(0, 3)) {
    try {
      const item = db.prepare('SELECT * FROM catalog WHERE id = ? AND org_id = ? AND active = 1').get(w.itemId, org.id);
      if (!item) continue;
      const r = await sendItem(org, chat, item, w.kind || 'all');
      if (r.sent) notes.push(`${item.name} (${r.images ? r.images + ' photo' + (r.images > 1 ? 's' : '') : ''}${r.images && r.videos ? ', ' : ''}${r.videos ? r.videos + ' vidéo' : ''})`);
    } catch (e) { log.warn('WhatsApp : envoi de fichier impossible :', oneLine(e.message, 160)); }
  }
  if (notes.length) db.prepare("INSERT INTO chat_messages (chat_id, role, content, created_at) VALUES (?, 'assistant', ?, ?)").run(chat.id, `[fichier envoyé] ${notes.join(' ; ')}`, nowISO());
  return notes.length;
}

// ---------- Gestion des fichiers d'un article (responsables et plus) ----------
const router = express.Router({ mergeParams: true });
const upLimit = limits.make(10 * 60 * 1000, 40, 'Trop d\'envois de fichiers. Réessayez dans quelques minutes.');
const itemOf = (req) => { const it = db.prepare('SELECT * FROM catalog WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id); if (!it) throw new HttpError(404, 'Article introuvable.'); return it; };

router.get('/catalog/:id/media', (req, res) => { itemOf(req); res.json({ media: mediaFor(A.id(req.params.id)).map(metaOf), limits: { image: MAX_IMG, video: MAX_VID, perItem: MAX_PER_ITEM } }); });
router.post('/catalog/:id/media', upLimit, express.raw({ type: () => true, limit: MAX_VID + 1024 }), (req, res) => {
  const it = itemOf(req);
  const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const t = sniff(buf);
  if (!t) throw new HttpError(400, 'Fichier non reconnu : envoyez une photo (JPEG, PNG, WebP) ou une vidéo MP4.');
  if (t.kind === 'image' && buf.length > MAX_IMG) throw new HttpError(413, 'Photo trop lourde (3 Mo au plus). Réduisez-la ou prenez-la en qualité normale.');
  if (t.kind === 'video' && buf.length > MAX_VID) throw new HttpError(413, 'Vidéo trop lourde (16 Mo au plus, limite de WhatsApp).');
  if (mediaFor(it.id).length >= MAX_PER_ITEM) throw new HttpError(403, `Cet article a déjà ${MAX_PER_ITEM} fichiers. Supprimez-en un pour en ajouter.`);
  const used = db.prepare('SELECT COALESCE(SUM(size), 0) s FROM catalog_media WHERE org_id = ?').get(req.org.id).s;
  if (used + buf.length > MAX_ORG) throw new HttpError(403, 'Espace de fichiers plein (80 Mo). Supprimez d\'anciens fichiers.');
  const id = db.prepare('INSERT INTO catalog_media (org_id, item_id, kind, mime, size, name, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(req.org.id, it.id, t.kind, t.mime, buf.length, cleanText(String(req.query.name || ''), 80), buf, nowISO()).lastInsertRowid;
  A.logActivity(req.org.id, req.user.id, 'sales', `${t.kind === 'video' ? 'Vidéo' : 'Photo'} ajoutée à « ${it.name} »`);
  res.status(201).json({ id: Number(id), kind: t.kind });
});
router.get('/catalog/:id/media/:mid/file', (req, res) => {
  const it = itemOf(req);
  const m = db.prepare('SELECT * FROM catalog_media WHERE id = ? AND item_id = ?').get(A.id(req.params.mid), it.id);
  if (!m) throw new HttpError(404, 'Fichier introuvable.');
  res.set({ 'Content-Type': m.mime, 'Content-Length': m.data.length, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Content-Disposition': 'inline' });
  res.end(m.data);
});
router.delete('/catalog/:id/media/:mid', (req, res) => {
  const it = itemOf(req);
  db.prepare('DELETE FROM catalog_media WHERE id = ? AND item_id = ?').run(A.id(req.params.mid), it.id);
  res.json({ ok: true });
});

// Un responsable envoie lui-même les photos/vidéos d'un article à une personne qui lui écrit sur WhatsApp (dans les 24 h).
router.post('/chats/:id/send-media', asyncHandler(async (req, res) => {
  const chat = db.prepare('SELECT * FROM chats WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!chat || chat.channel === 'web') throw new HttpError(404, 'Conversation introuvable.');
  if (!channels.isConnected(req.org, chat.channel)) throw new HttpError(400, "Ce canal n'est pas connecté.");
  const last = db.prepare("SELECT created_at FROM chat_messages WHERE chat_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1").get(chat.id);
  if (!last || Date.now() - Date.parse(last.created_at) > 24 * 3600000) throw new HttpError(400, "Plus de 24 h depuis le dernier message du client : Meta n'autorise plus l'envoi libre.");
  const item = db.prepare('SELECT * FROM catalog WHERE id = ? AND org_id = ?').get(A.id((req.body || {}).itemId), req.org.id);
  if (!item) throw new HttpError(404, 'Article introuvable.');
  const kind = A.oneOf((req.body || {}).kind, ['all', 'image', 'video'], 'all', 'Type inconnu.');
  if (!mediaFor(item.id).some((m) => kind === 'all' || m.kind === kind)) throw new HttpError(400, "Cet article n'a pas de fichier de ce type.");
  let r;
  try { r = await sendItem(req.org, chat, item, kind); } catch (e) { throw new HttpError(502, "Le fichier n'a pas pu partir. Vérifiez la connexion du canal (et API_PUBLIC_URL pour Messenger et Instagram)."); }
  db.prepare("INSERT INTO chat_messages (chat_id, role, content, created_at) VALUES (?, 'staff', ?, ?)").run(chat.id, `[fichier envoyé] ${item.name} (${r.images} photo(s), ${r.videos} vidéo(s))`, nowISO());
  A.logActivity(req.org.id, req.user.id, 'sales', `Photos/vidéos de « ${item.name} » envoyées à un client`);
  res.json({ ok: true, sent: r.sent });
}));

module.exports = { router, sendForChat, mediaFor, sniff };
