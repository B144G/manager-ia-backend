'use strict';
// RH Talents · point d'entrée : monte tous les sous-modules sous /talents. Aucun accès par le rôle d'organisation : chaque route contrôle
// les rôles RH (rh, recrut, talent, remun) désignés par le propriétaire, ou le lien employé ↔ compte pour ce qui concerne l'intéressé.
const express = require('express');
const router = express.Router({ mergeParams: true });
for (const f of ['rh-gpec', 'rh-recruit', 'rh-mbo', 'rh-360', 'rh-training', 'rh-talent', 'rh-comp', 'rh-workforce', 'rh-career', 'rh-kpi']) {
  router.use(f === 'rh-recruit' ? '/recruitment' : f === 'rh-kpi' ? '/' : '/', require('./' + f));
}
module.exports = router;
