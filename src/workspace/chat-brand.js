'use strict';
// Point d'entrée UNIQUE du nom du produit pour le chat interne (serveur) : la constante centrale src/services/product.js.
// (La variable d'environnement PRODUCT_NAME, si elle est définie, la remplace pour le chat seulement.)
const PRODUCT = require('../services/product');
const PRODUCT_NAME = String(process.env.PRODUCT_NAME || PRODUCT.name).trim().slice(0, 40) || PRODUCT.name;
const AI_NAME = process.env.PRODUCT_NAME ? `${PRODUCT_NAME} IA` : PRODUCT.assistantName;
module.exports = { PRODUCT_NAME, AI_NAME };
