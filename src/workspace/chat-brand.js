'use strict';
// Point d'entrée UNIQUE du nom du produit pour le chat interne (serveur). Pour renommer le produit : variable PRODUCT_NAME,
// ou (après la fusion) brancher ici la constante centrale du nom du produit. Aucun autre fichier du chat ne contient le nom.
const PRODUCT_NAME = String(process.env.PRODUCT_NAME || 'Brij-IA').trim().slice(0, 40) || 'Brij-IA';
const AI_NAME = `${PRODUCT_NAME} IA`;
module.exports = { PRODUCT_NAME, AI_NAME };
