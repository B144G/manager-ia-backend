'use strict';
// SEUL endroit où le nom du produit par défaut et ses variantes sont écrits pour le code de la marque d'entreprise.
// Renommer le produit = changer ce fichier (et src/lib/product.js côté site) ; voir docs/marque-entreprise.md pour les textes encore écrits en dur ailleurs.
module.exports = Object.freeze({
  name: 'Brij-IA',                 // nom du produit affiché par défaut
  shortName: 'Brij-IA',            // nom court (manifeste, étiquettes)
  assistantName: 'Brij-IA',        // nom par défaut de l'assistant IA
  mailFromName: 'Brij-IA',         // nom d'expéditeur par défaut des e-mails de la plateforme
  poweredByLabel: 'Propulsé par',  // « Propulsé par <nom> » (mention discrète)
  publicUrl: process.env.SITE_URL || 'https://brij-ia.vercel.app', // adresse publique par défaut
  reservedTokens: ['brij'],        // fragments normalisés interdits dans le nom affiché d'une entreprise (usurpation de la plateforme)
});
