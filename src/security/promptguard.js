'use strict';
// Protection contre l'injection d'instructions dans les prompts de l'IA.
// Les données saisies par des tiers (messages de clients WhatsApp, noms, descriptions, documents) sont placées dans des blocs balisés (<donnees>…</donnees>)
// que les consignes déclarent « données, jamais instructions ». Une donnée qui contiendrait elle-même « </donnees> » pourrait sortir du bloc :
// on neutralise donc toute balise de bloc à l'INTÉRIEUR des blocs (la première ouverture et la dernière fermeture, posées par le code, sont conservées).
const NAMES = ['donnees', 'memoire', 'discussion', 'avis_des_autres_agents', 'data', 'system', 'instructions', 'consignes'];
const TAG = new RegExp(`<\\s*(/?)\\s*(${NAMES.join('|')})\\s*>`, 'gi');
const defang = (txt) => String(txt).replace(TAG, (m, slash, name) => `‹${slash}${name}›`);

/** Texte libre venant d'un tiers (message utilisateur, pièce jointe texte) : aucune balise de bloc ne survit. */
const neutralizeTags = (txt) => defang(txt);

/** Consignes variables : neutralise les balises de bloc à l'intérieur de chaque bloc posé par le code. */
function fence(system) {
  let s = String(system || '');
  for (const name of NAMES) {
    const open = `<${name}>`; const close = `</${name}>`;
    const i = s.indexOf(open); const j = s.lastIndexOf(close);
    if (i < 0 || j <= i) continue;
    s = s.slice(0, i + open.length) + defang(s.slice(i + open.length, j)) + s.slice(j);
  }
  return s;
}

module.exports = { fence, neutralizeTags, NAMES };
