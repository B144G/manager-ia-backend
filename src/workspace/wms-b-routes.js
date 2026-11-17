'use strict';
// Entrepôt (fusion) : capacités de la ligne B dont la FORME diffère de celle de A, montées sous /stock/wms/b/… pour ne pas changer
// les routes de A (le site de production consomme les chemins de A). Mêmes données (wms_stock, stock_moves, wms_item_params…).
//   /b/forecast, /b/forecast/:id, /b/reorder, /b/items/:id/params   (prévision avec indice saisonnier, point de commande, stock de sécurité, délai fournisseur)
//   /b/reports/valuation|rotation|stockouts|aging|moves, /b/scan   (états, exports CSV, résolution des codes scannés)
const express = require('express');
const router = express.Router({ mergeParams: true });
for (const f of ['forecast', 'reports']) router.use('/', require('./stock-wms-' + f));
module.exports = router;
