'use strict';
// Avis et recommandations — côté utilisateur et témoignages publics.
//   /api/ws/orgs/:orgId/feedback   (membre connecté de l'organisation)
//     GET  /meta                     types, modules, limites
//     POST /                         envoyer un avis (note 1-5, score 0-10, type, module, message, anonyme, consentement public)
//     POST /:id/screenshot           joindre une capture (PNG, JPEG ou WebP, 2 Mo au plus, type vérifié sur le contenu) — une seule, juste après l'envoi
//     GET  /mine                     mes avis (jamais les notes internes du fondateur)
//     GET  /mine/:id/screenshot      ma capture
//     PUT  /mine/:id/consent         donner / retirer mon consentement à l'affichage public
//     DELETE /mine/:id               supprimer mon avis
//   /api/ws/public/testimonials      témoignages : approuvés par l'administrateur ET consentis, jamais de nom pour un avis anonyme
const express = require('express');
const { db, nowISO } = require('../db');
const limits = require('../middleware/limits');
const central = require('../security');
const F = require('../services/feedback');
const { modules } = require('./modules');
const A = require('./access');
const { HttpError, asyncHandler } = require('../util');

const router = express.Router({ mergeParams: true });
const sendLimit = limits.make(60 * 60 * 1000, 60, 'Trop d’envois. Merci de réessayer dans une heure.', { shared: true, prefix: 'feedbacksend' }) // par adresse (un bureau partage souvent la sienne) ; le vrai plafond est par personne (services/feedback.js);
const shotLimit = limits.make(60 * 60 * 1000, 30, 'Trop d’envois d’images. Réessayez dans une heure.', { shared: true, prefix: 'feedbackshot' });
const readLimit = limits.make(60 * 1000, 120, 'Trop de requêtes. Patientez une minute.');
const rawBody = express.raw({ type: () => true, limit: `${Math.ceil(F.SHOT_MAX / 1048576) + 1}mb` });
const earlySize = (req, res, next) => {
  if (Number(req.get('content-length') || 0) > F.SHOT_MAX + 2048) throw new HttpError(413, `Image trop lourde (${Math.round(F.SHOT_MAX / 1048576)} Mo au plus).`);
  next();
};
const SEC = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Cross-Origin-Resource-Policy': 'same-site' };

router.get('/meta', readLimit, (req, res) => {
  res.json({
    kinds: F.KINDS.map((k) => ({ id: k, label: F.KIND_LABEL[k] })),
    modules: [{ id: 'general', title: 'Ensemble du logiciel' }, ...modules.filter((m) => !m.hidden).map((m) => ({ id: m.id, title: m.title }))],
    limits: { body: F.BODY_MAX, screenshotBytes: F.SHOT_MAX, screenshotTypes: ['image/png', 'image/jpeg', 'image/webp'] },
  });
});

/** Mon avis (par l'empreinte de l'auteur) dans CETTE organisation : jamais celui d'une autre personne ni d'une autre organisation. */
async function mine(req, id) {
  const r = await db.prepare('SELECT * FROM fb_feedback WHERE id = ? AND org_id = ? AND author_hash = ?').get(A.id(id, 'Avis introuvable.'), req.org.id, F.authorHash(req.user.id));
  if (!r) throw new HttpError(404, 'Avis introuvable.');
  return r;
}

router.post('/', sendLimit, asyncHandler(async (req, res) => {
  const v = F.validate(req.body, req.user, String(req.get('x-lang') || (req.body && req.body.lang) || 'fr').slice(0, 2));
  const id = await F.create(req, req.org, v);
  await central.audit.record(req, 'feedback.create', { orgId: req.org.id, target: `feedback:${id}`, detail: `${v.kind} ${v.stars}/5 ${v.module}${v.anonymous ? ' anonyme' : ''}${v.publicConsent ? ' public' : ''}` });
  F.notifyNew(id);
  res.status(201).json({ id, ok: true });
}));

router.post('/:id/screenshot', shotLimit, earlySize, rawBody, asyncHandler(async (req, res) => {
  const r = await mine(req, req.params.id);
  if (Number(r.shot_size) > 0) throw new HttpError(409, 'Une capture est déjà jointe à cet avis.');
  if (Date.now() - Date.parse(r.created_at) > 60 * 60 * 1000) throw new HttpError(409, 'La capture se joint dans l’heure qui suit l’envoi.');
  const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!buf.length) throw new HttpError(400, 'Aucune image reçue.');
  if (buf.length > F.SHOT_MAX) throw new HttpError(413, `Image trop lourde (${Math.round(F.SHOT_MAX / 1048576)} Mo au plus).`);
  const t = F.sniffImage(buf);
  if (!t) throw new HttpError(400, 'Image non reconnue : formats acceptés PNG, JPEG ou WebP.');
  await db.prepare('UPDATE fb_feedback SET shot = ?, shot_mime = ?, shot_size = ?, updated_at = ? WHERE id = ?').run(require('./legal-extra').seal(buf), t.mime, buf.length, nowISO(), r.id);
  await central.audit.record(req, 'feedback.screenshot', { orgId: req.org.id, target: `feedback:${r.id}`, detail: `${t.mime} ${buf.length} octets` });
  res.status(201).json({ ok: true, size: buf.length });
}));

router.get('/mine', readLimit, asyncHandler(async (req, res) => {
  const rows = await db.prepare('SELECT * FROM fb_feedback WHERE org_id = ? AND author_hash = ? ORDER BY id DESC LIMIT 50').all(req.org.id, F.authorHash(req.user.id));
  res.json({ items: rows.map(F.mineView) });
}));

router.get('/mine/:id/screenshot', readLimit, asyncHandler(async (req, res) => {
  const r = await mine(req, req.params.id);
  const data = Number(r.shot_size) > 0 ? require('./legal-extra').unseal(r.shot) : null;
  if (!data) throw new HttpError(404, 'Aucune capture.');
  res.set({ ...SEC, 'Content-Type': r.shot_mime, 'Content-Length': data.length });
  res.end(data);
}));

router.put('/mine/:id/consent', sendLimit, asyncHandler(async (req, res) => {
  const r = await mine(req, req.params.id);
  const on = req.body && F.bool(req.body.publicConsent);
  if (on) {
    if (r.kind !== 'review' || String(r.body).length < 10) throw new HttpError(400, 'Seul un avis rédigé peut être proposé comme témoignage public.');
    await db.prepare('UPDATE fb_feedback SET public_consent = 1, consent_at = ?, updated_at = ? WHERE id = ?').run(nowISO(), nowISO(), r.id);
  } else { // retrait : le témoignage disparaît aussitôt de l'affichage public et l'approbation tombe
    await db.prepare('UPDATE fb_feedback SET public_consent = 0, approved_at = NULL, updated_at = ? WHERE id = ?').run(nowISO(), r.id);
  }
  await central.audit.record(req, on ? 'feedback.consent_given' : 'feedback.consent_withdrawn', { orgId: req.org.id, target: `feedback:${r.id}` });
  res.json({ item: F.mineView(await db.prepare('SELECT * FROM fb_feedback WHERE id = ?').get(r.id)) });
}));

router.delete('/mine/:id', sendLimit, asyncHandler(async (req, res) => {
  const r = await mine(req, req.params.id);
  await db.prepare('DELETE FROM fb_feedback WHERE id = ?').run(r.id);
  await central.audit.record(req, 'feedback.delete_own', { orgId: req.org.id, target: `feedback:${r.id}` });
  res.json({ ok: true });
}));

// ---------- Public : témoignages ----------
const pubRouter = express.Router();
const pubLimit = limits.make(60 * 1000, 60, 'Trop de requêtes.');
pubRouter.get('/', pubLimit, asyncHandler(async (req, res) => {
  const n = Math.min(Math.max(parseInt(req.query.limit, 10) || 6, 1), 20);
  const rows = await db.prepare('SELECT id, stars, body, module, anonymous, display_name, approved_at FROM fb_feedback WHERE public_consent = 1 AND approved_at IS NOT NULL AND kind = ? AND body <> ? ORDER BY approved_at DESC LIMIT ?').all('review', '', n);
  res.set('Cache-Control', 'public, max-age=60');
  res.json({ items: rows.map((r) => ({ id: Number(r.id), stars: Number(r.stars), text: String(r.body).slice(0, 600), name: Number(r.anonymous) ? '' : r.display_name, moduleTitle: F.moduleTitle(r.module), at: String(r.approved_at).slice(0, 10) })) });
}));

module.exports = { router, pubRouter };
