'use strict';
// Assistant IA du site : simple relais vers l'API Anthropic (la clé reste côté serveur).
const express = require('express');
const config = require('../config');
const limits = require('../middleware/limits');
const claude = require('../services/claude');
const knowledge = require('../ai/knowledge');
const { asyncHandler, HttpError, cleanText, log, oneLine } = require('../util');

const router = express.Router();
const daily = limits.make(24 * 3600 * 1000, config.assistantDailyLimit, "Limite quotidienne de l'assistant atteinte. Réessayez demain ou contactez-nous sur WhatsApp.");

router.post('/assistant', limits.assistantMinute, daily, asyncHandler(async (req, res) => {
  if (!claude.isConfigured()) throw new HttpError(503, 'Assistant indisponible');
  const b = req.body || {};
  const extra = knowledge.load('site');
  let system = claude.SITE_PROMPT + (extra ? `\n\nConnaissances supplémentaires fournies par Brij-IA :\n${extra}` : '');
  let messages;

  if (b.mode === 'app') {
    const kind = cleanText(b.kind, 200) || 'non précisée';
    const need = cleanText(b.need, 1000);
    if (!need) throw new HttpError(400, 'Décrivez votre besoin.');
    system = claude.APP_PROMPT;
    messages = [{ role: 'user', content: `Activité : ${kind}\nBesoin : ${need}` }];
  } else {
    if (!Array.isArray(b.messages) || b.messages.length === 0) throw new HttpError(400, 'Aucun message à traiter.');
    messages = b.messages
      .slice(-12)
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .map((m) => ({ role: m.role, content: cleanText(m.content, 2000) }))
      .filter((m) => m.content);
    while (messages.length && messages[0].role !== 'user') messages.shift(); // doit commencer par l'utilisateur
    if (!messages.length || messages[messages.length - 1].role !== 'user') throw new HttpError(400, 'Le dernier message doit venir de l\'utilisateur.');
  }

  try {
    const text = await claude.ask({ stable: system, messages, maxTokens: 600, tier: 'fast' });
    res.json({ text });
  } catch (e) {
    if (e instanceof HttpError) throw e;
    log.warn('Assistant : appel Claude échoué :', oneLine(e.message, 200));
    throw new HttpError(502, "L'assistant n'a pas pu répondre. Réessayez dans un instant.");
  }
}));

module.exports = router;
