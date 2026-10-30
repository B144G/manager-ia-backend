'use strict';
// Socle commun des tests de la vague 2 : même serveur jetable que la vague 1 (PostgreSQL embarqué, organisation de test avec propriétaire,
// responsable et simple membre). Usage : require('./lib/wave2').run('titre', async (t) => { ... }).
module.exports = require('./wave1');
