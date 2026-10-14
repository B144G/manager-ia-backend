'use strict';
// E-mails aux clients : l'IA rédige, la personne relit et envoie (jamais d'envoi automatique). Pièces jointes : images et PDF.
// Garde-fous : destinataire = un client enregistré avec une adresse e-mail (pas d'envoi libre : pas de spam), quota par jour selon l'offre,
// limite par minute, journal des envois.
const express = require('express');
const { db, nowISO } = require('../db');
const limits = require('../middleware/limits');
const A = require('./access');
const { sendMail, mailEnabled } = require('../services/notify');
const { HttpError, asyncHandler, isEmail, oneLine, log } = require('../util');

const router = express.Router({ mergeParams: true });
router.use(A.need('manager'));

const MAX_FILE = 2 * 1024 * 1024;   // 2 Mo par fichier
const MAX_FILES = 40;               // fichiers conservés par organisation
const MAX_ATTACH = 3;               // pièces jointes par e-mail
const MAX_TOTAL = 5 * 1024 * 1024;  // poids total des pièces jointes d'un e-mail

/** Type réel du fichier d'après ses premiers octets (on ne se fie jamais au type annoncé). */
function sniff(buf) {
  if (buf.length > 4 && buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') return 'image/png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.toString('latin1', 0, 4) === 'GIF8') return 'image/gif';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.toString('latin1', 0, 4) === '%PDF') return 'application/pdf';
  return null;
}
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'application/pdf': 'pdf' };

router.get('/', (req, res) => {
  const lim = A.limitsFor(A.ownerPlan(req.org)).emailDay;
  const used = db.prepare("SELECT COUNT(*) c FROM outbox WHERE org_id = ? AND status = 'sent' AND created_at >= ?").get(req.org.id, `${nowISO().slice(0, 10)}T00:00:00.000Z`).c;
  res.json({
    enabled: mailEnabled(), limitPerDay: lim, sentToday: used,
    files: db.prepare('SELECT id, name, mime, size, created_at AS at FROM org_files WHERE org_id = ? ORDER BY id DESC').all(req.org.id),
    outbox: db.prepare('SELECT o.id, o.to_email AS toEmail, o.subject, o.status, o.created_at AS at, o.attachments, u.name AS sender FROM outbox o LEFT JOIN users u ON u.id = o.user_id WHERE o.org_id = ? ORDER BY o.id DESC LIMIT 30').all(req.org.id).map((r) => ({ ...r, attachments: JSON.parse(r.attachments) })),
  });
});

// Téléversement : JSON {name, data (base64)}. La limite de taille de cette route est réglée ici (la route est exclue de la limite générale).
router.post('/files', express.json({ limit: '3.5mb' }), (req, res) => {
  const b = req.body || {};
  if (typeof b.data !== 'string' || !b.data) throw new HttpError(400, 'Aucun fichier reçu.');
  const buf = Buffer.from(b.data, 'base64');
  if (!buf.length) throw new HttpError(400, 'Fichier vide.');
  if (buf.length > MAX_FILE) throw new HttpError(413, 'Fichier trop lourd (2 Mo au maximum). Réduisez la taille de l\'image.');
  const mime = sniff(buf);
  if (!mime) throw new HttpError(400, 'Format non accepté. Envoyez une image (PNG, JPEG, GIF, WebP) ou un PDF. Pour une vidéo, mettez plutôt un lien dans le message.');
  if (db.prepare('SELECT COUNT(*) c FROM org_files WHERE org_id = ?').get(req.org.id).c >= MAX_FILES) throw new HttpError(403, `Vous avez déjà ${MAX_FILES} fichiers : supprimez-en avant d'en ajouter.`);
  const base = A.text(String(b.name || '').replace(/\.[A-Za-z0-9]{1,5}$/, '').replace(/[^\p{L}\p{N} _.-]/gu, ''), 60) || 'fichier';
  const name = `${base}.${EXT[mime]}`;
  const id = db.prepare('INSERT INTO org_files (org_id, name, mime, size, data, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(req.org.id, name, mime, buf.length, buf, req.user.id, nowISO()).lastInsertRowid;
  res.status(201).json({ id: Number(id), name, mime, size: buf.length });
});

router.delete('/files/:id', (req, res) => {
  const r = db.prepare('DELETE FROM org_files WHERE id = ? AND org_id = ?').run(A.id(req.params.id), req.org.id);
  if (!r.changes) throw new HttpError(404, 'Fichier introuvable.');
  res.json({ ok: true });
});

router.post('/send', limits.make(60 * 1000, 8, 'Vous envoyez trop vite. Patientez une minute.'), asyncHandler(async (req, res) => {
  if (!mailEnabled()) throw new HttpError(503, "L'envoi d'e-mails n'est pas encore activé sur ce serveur.");
  const b = req.body || {};
  const cu = db.prepare('SELECT * FROM customers WHERE id = ? AND org_id = ?').get(A.id(b.customerId, 'Choisissez un client.'), req.org.id);
  if (!cu || !A.visible(req, cu)) throw new HttpError(404, 'Client introuvable.');
  if (!isEmail(cu.email)) throw new HttpError(400, `${cu.name} n'a pas d'adresse e-mail : ajoutez-la sur sa fiche.`);
  const subject = oneLine(A.text(b.subject, 150, { required: true, msg: "Indiquez l'objet du message." }), 150);
  const body = A.text(b.body, 5000, { required: true, msg: 'Écrivez votre message.' });

  const ids = Array.isArray(b.fileIds) ? [...new Set(b.fileIds.map((x) => A.id(x)))] : [];
  if (ids.length > MAX_ATTACH) throw new HttpError(400, `${MAX_ATTACH} pièces jointes au maximum.`);
  const files = ids.map((id) => { const f = db.prepare('SELECT * FROM org_files WHERE id = ? AND org_id = ?').get(id, req.org.id); if (!f) throw new HttpError(404, 'Pièce jointe introuvable.'); return f; });
  if (files.reduce((a, f) => a + f.size, 0) > MAX_TOTAL) throw new HttpError(400, 'Pièces jointes trop lourdes (5 Mo au total).');

  const lim = A.limitsFor(A.ownerPlan(req.org)).emailDay;
  const used = db.prepare("SELECT COUNT(*) c FROM outbox WHERE org_id = ? AND status = 'sent' AND created_at >= ?").get(req.org.id, `${nowISO().slice(0, 10)}T00:00:00.000Z`).c;
  if (used >= lim) throw new HttpError(429, `Limite de ${lim} e-mails par jour atteinte pour votre offre. Réessayez demain ou passez à une offre supérieure à la fin de votre abonnement.`);

  const owner = db.prepare('SELECT contact FROM users WHERE id = ?').get(req.org.owner_id);
  const replyTo = [req.user.contact, owner && owner.contact].find((c) => isEmail(c));
  const text = `${body}\n\n—\n${req.org.name}\nMessage envoyé avec MANAGER-IA`;
  let status = 'sent'; let error = '';
  try {
    await sendMail({ to: cu.email, subject, text, replyTo, fromName: req.org.name, attachments: files.map((f) => ({ filename: f.name, content: f.data, contentType: f.mime })) });
  } catch (e) {
    status = 'failed'; error = oneLine(e.message, 200);
    log.warn('E-mail client non envoyé :', error);
  }
  db.prepare('INSERT INTO outbox (org_id, user_id, customer_id, to_email, subject, body, attachments, status, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(req.org.id, req.user.id, cu.id, cu.email, subject, body, JSON.stringify(files.map((f) => f.name)), status, error, nowISO());
  if (status === 'failed') throw new HttpError(502, "Le message n'a pas pu partir. Vérifiez l'adresse e-mail du client puis réessayez.");
  A.logActivity(req.org.id, req.user.id, 'crm', `E-mail envoyé à ${cu.name}`);
  res.json({ ok: true, sentToday: used + 1, limitPerDay: lim });
}));

module.exports = router;
