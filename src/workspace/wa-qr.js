'use strict';
// Connexion WhatsApp par QR code (« Appareils connectés »), réservée aux administrateurs de l'organisation.
// Montée sous /api/ws/orgs/:orgId/sales/wa-qr. Le QR code et le code de jumelage ne sont JAMAIS écrits dans les journaux ni dans la base.
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const limits = require('../middleware/limits');
const waWeb = require('../services/waWeb');
const { HttpError, asyncHandler, log, oneLine } = require('../util');

const router = express.Router({ mergeParams: true });
router.use(A.need('admin'));
const statusLimit = limits.make(60 * 1000, 60, 'Trop de demandes. Patientez un instant.');
const startLimit = limits.make(10 * 60 * 1000, 10, 'Trop de tentatives de connexion. Réessayez dans quelques minutes.');
const pairLimit = limits.make(10 * 60 * 1000, 8, 'Trop de demandes de code. Réessayez dans quelques minutes.');

async function qrSvg(raw) {
  try { return await require('qrcode').toString(raw, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }); } catch { return null; }
}
async function view(org) {
  const av = await waWeb.availability();
  const st = waWeb.status(org.id);
  const row = await db.prepare('SELECT * FROM wa_qr_sessions WHERE org_id = ?').get(org.id);
  const fresh = await db.prepare('SELECT wa_mode FROM orgs WHERE id = ?').get(org.id);
  const out = { enabled: av.ok, mode: fresh && fresh.wa_mode === 'qr' ? 'qr' : 'meta', status: st.status, number: st.number || (row && row.number) || '', since: st.since || (row && row.since) || null, acknowledged: Boolean(row && row.accepted_at) };
  if (!av.ok) out.message = av.reason;
  if (st.status === 'qr' && st.qr) { const svg = await qrSvg(st.qr); if (svg) out.qrSvg = svg; }
  return out;
}
const fail = (e) => {
  if (e instanceof HttpError) return e;
  const code = { unavailable: 503, full: 503, locked: 409, state: 409, input: 400 }[e && e.code];
  if (code) return new HttpError(code, e.message);
  log.warn('WhatsApp QR : erreur :', oneLine(e && e.message, 120));
  return new HttpError(502, "La connexion WhatsApp n'a pas pu s'établir. Réessayez dans un instant.");
};

router.get('/status', statusLimit, asyncHandler(async (req, res) => res.json(await view(req.org))));

router.post('/start', startLimit, asyncHandler(async (req, res) => {
  if (!req.body || req.body.accept !== true) throw new HttpError(400, 'Cochez « Je comprends les risques » pour continuer.');
  try { await waWeb.start(req.org.id, { accepted: { at: nowISO(), by: req.user.id } }); } catch (e) { throw fail(e); }
  await A.logActivity(req.org.id, req.user.id, 'sales', 'Connexion WhatsApp par QR code démarrée');
  res.json(await view(req.org));
}));

router.post('/pairing', pairLimit, asyncHandler(async (req, res) => {
  const phone = req.body && req.body.phone;
  if (typeof phone !== 'string' || !/^[+\d\s().-]{8,24}$/.test(phone)) throw new HttpError(400, "Numéro invalide : indiquez-le avec l'indicatif du pays, par exemple 237677112233.");
  try { res.json({ code: await waWeb.pairing(req.org.id, phone) }); } catch (e) { throw fail(e); }
}));

router.post('/stop', startLimit, asyncHandler(async (req, res) => {
  try { await waWeb.stop(req.org.id); } catch (e) { throw fail(e); }
  await A.logActivity(req.org.id, req.user.id, 'sales', 'WhatsApp (QR code) déconnecté');
  res.json(await view(req.org));
}));

module.exports = router;
