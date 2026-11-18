'use strict';
// Module « Commercial » (CRM complet, prospection, pipeline, segmentation, SPIN/BANT, prévision, devis, tarifs et marges, fidélisation, force de vente, performance).
// Monté sur /api/ws/orgs/:orgId/commercial. Les droits sont contrôlés ici (perm.js), jamais seulement à l'écran.
const express = require('express');
const router = express.Router({ mergeParams: true });
const pub = express.Router();

for (const f of ['crm360', 'prospect', 'pipeline', 'segments', 'bant']) router.use('/', require('./' + f).router);

const tickAll = async () => { await require('./prospect').tickAll(); };
module.exports = { router, pub, tickAll };
