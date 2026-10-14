'use strict';
// Formulaire de contact : enregistre une demande (lead) et prévient l'administrateur.
const express = require('express');
const { db, nowISO } = require('../db');
const limits = require('../middleware/limits');
const { notify } = require('../services/notify');
const { HttpError, cleanText, oneLine } = require('../util');

const router = express.Router();

router.post('/contact', limits.contact, (req, res) => {
  const b = req.body || {};
  const name = cleanText(b.name, 100);
  const what = cleanText(b.what, 200);
  const message = cleanText(b.message, 2000);
  const contact = cleanText(b.contact, 120);
  if (name.length < 2) throw new HttpError(400, 'Veuillez indiquer votre nom.');
  if (message.length < 2) throw new HttpError(400, 'Veuillez écrire votre message.');

  db.prepare('INSERT INTO leads (name, what, message, contact, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(name, what, message, contact, nowISO());
  notify('contact', `Nouvelle demande de ${name}${contact ? ' (' + contact + ')' : ''} - ${what || 'sans sujet'} : « ${oneLine(message, 250)} »`);
  res.json({ ok: true });
});

module.exports = router;
