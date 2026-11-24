'use strict';
// Contexte de marque de la requête en cours (AsyncLocalStorage), sans aucune dépendance à la base : utilisable par les modules de rendu (PDF) même hors serveur.
const { AsyncLocalStorage } = require('async_hooks');
const als = new AsyncLocalStorage();
const current = () => { const s = als.getStore(); return s ? s.brand : null; };
const currentOrgId = () => { const s = als.getStore(); return s ? s.orgId : null; };
module.exports = { als, current, currentOrgId };
