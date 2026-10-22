'use strict';
// Sous-application « fiscal » (squelette : sera complétée).
const express = require('express');

const router = express.Router({ mergeParams: true });
router.get('/', (req, res) => res.json({ ok: true }));

module.exports = router;
// Crochets facultatifs lus par ai.js : ctx(req) = données vues par l'IA ; prompt = consignes propres au module ; min = rôle minimal pour l'IA.
module.exports.ctx = async () => '';
module.exports.prompt = '';
