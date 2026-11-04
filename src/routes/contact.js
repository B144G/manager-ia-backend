'use strict';
// Formulaire de contact : enregistre une demande (lead) et prévient l'administrateur.
// Les coordonnées viennent toujours d'une personne qui les laisse volontairement. Les relances par e-mail ne partent que si la case de consentement est cochée.
const crypto = require('crypto');
const express = require('express');
const config = require('../config');
const { db, nowISO } = require('../db');
const limits = require('../middleware/limits');
const { notify } = require('../services/notify');
const prospects = require('../services/prospects');
const { HttpError, cleanText, oneLine } = require('../util');

const router = express.Router();

router.post('/contact', limits.contact, async (req, res) => {
  const b = req.body || {};
  if (cleanText(b.website, 50)) return res.json({ ok: true }); // champ piège : un robot le remplit, une personne ne le voit pas
  const name = cleanText(b.name, 100);
  const what = cleanText(b.what, 200);
  const message = cleanText(b.message, 2000);
  const contact = cleanText(b.contact, 120);
  const source = cleanText(b.source, 30).toLowerCase().replace(/[^a-z0-9_-]/g, '');
  if (name.length < 2) throw new HttpError(400, 'Veuillez indiquer votre nom.');
  if (message.length < 2) throw new HttpError(400, 'Veuillez écrire votre message.');

  const { email, phone } = prospects.splitContact(contact);
  const consent = b.consent === true || b.consent === 'true' || b.consent === 1 ? 1 : 0;
  const follow = consent && email;
  await db.prepare('INSERT INTO leads (name, what, message, contact, created_at, email, phone, source, consent, next_follow_at, unsub_token) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(name, what, message, contact, nowISO(), email, phone, source, consent, follow ? prospects.firstFollowAt() : null, follow ? crypto.randomBytes(16).toString('hex') : null);
  notify('contact', `Nouvelle demande de ${name}${contact ? ' (' + contact + ')' : ''}${source ? ' [' + source + ']' : ''} - ${what || 'sans sujet'} : « ${oneLine(message, 250)} »`);
  res.json({ ok: true });
});

// Compteur de visites anonyme : page, origine (UTM ou site d'où vient la personne) et type d'appareil. Aucune adresse IP, aucun cookie, aucun identifiant.
router.post('/visit', limits.visit, async (req, res) => {
  const b = req.body || {};
  let own = '';
  try { own = new URL(config.siteUrl || '').hostname.replace(/^www\./, ''); } catch { /* adresse du site non réglée */ }
  await prospects.recordVisit({ path: cleanText(b.path, 80), ref: cleanText(b.ref, 200), utm: cleanText(b.utm, 40), ua: req.get('user-agent'), own });
  res.status(204).end();
});

// Lien de désinscription des relances par e-mail
router.get('/unsubscribe', limits.unsubscribe, async (req, res) => {
  const ok = await prospects.unsubscribe(req.query.t);
  res.set('Content-Type', 'text/html; charset=utf-8').set('Cache-Control', 'no-store').send(
    `<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Brij-IA</title><body style="font-family:system-ui,sans-serif;max-width:480px;margin:15vh auto;padding:0 20px;text-align:center"><h1>Brij-IA</h1><p>${ok ? 'C\'est fait : vous ne recevrez plus d\'e-mails de prospection de notre part.' : 'Ce lien n\'est plus valable ou la désinscription est déjà faite.'}</p></body></html>`
  );
});

module.exports = router;
