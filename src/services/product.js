'use strict';
// SEUL endroit où le nom du produit par défaut et ses variantes sont écrits pour le code de la marque d'entreprise.
// Renommer le produit = changer ce fichier (et src/lib/product.js côté site) ; voir docs/marque-entreprise.md pour les textes encore écrits en dur ailleurs.
module.exports = Object.freeze({
  name: 'MABAH',                 // nom du produit affiché par défaut
  shortName: 'MABAH',            // nom court (manifeste, étiquettes)
  assistantName: 'MABAH IA',        // nom par défaut de l'assistant IA
  mailFromName: 'MABAH',         // nom d'expéditeur par défaut des e-mails de la plateforme
  poweredByLabel: 'Propulsé par',  // « Propulsé par <nom> » (mention discrète)
  publicUrl: process.env.SITE_URL || 'https://mabah.vercel.app', // adresse publique par défaut
  legacyUrls: ['https://brij-ia.vercel.app'], // ancienne adresse : redirigée vers publicUrl (vercel.json) et acceptée comme origine pendant la transition
  reservedTokens: ['mabah', 'brij'],        // fragments normalisés interdits dans le nom affiché d'une entreprise (usurpation de la plateforme)
});
