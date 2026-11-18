'use strict';
// Sous-application « Trésorerie » (/api/ws/orgs/:orgId/treasury). Accès : propriétaire, administrateurs, responsable de trésorerie et trésoriers (désignés dans Trésorerie › Équipe).
//  tre-ops.js    rôles, réglages, comptes, taux de change, opérations (préparation, double validation, comptabilisation), journal, rapprochement
//  tre-views.js  prévision, calendrier, scénarios, créances, dettes, fonds de sécurité, écarts, indicateurs, tableau de bord, exports
//  tre-forecast.js / tre-calc.js  calculs purs ; tre-data.js  lecture des données et du grand livre ; tre-lib.js  droits, réglages, journal chaîné
const express = require('express');
const router = express.Router({ mergeParams: true });
router.use(require('./tre-lib').need('any'));
router.use(require('./tre-ops'));
router.use(require('./tre-views'));
module.exports = router;
