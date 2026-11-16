'use strict';
// Stock WMS (entrepôt) : un seul point de montage pour tous les lots (emplacements, transferts, réservations, retours…).
// Monté sur /stock/wms AVANT /stock (voir index.js). Chaque lot vit dans son fichier stock-wms-*.js.
const express = require('express');

const router = express.Router({ mergeParams: true });
for (const f of ['locations', 'transfers', 'reservations', 'returns', 'receipts', 'abc']) router.use('/', require('./stock-wms-' + f));

module.exports = router;
