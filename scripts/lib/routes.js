'use strict';
// Énumère TOUTES les routes de l'application Express (méthode + chemin complet), y compris celles des sous-routeurs.
// Sert aux tests de sécurité : aucune route ne doit échapper à la liste des routes publiques ni à l'isolation entre organisations.
function mountPath(layer) {
  if (layer.regexp && layer.regexp.fast_slash) return '';
  const src = layer.regexp.source.replace('\\/?', '').replace('(?=\\/|$)', '$');
  const m = /^\^((?:\\.|[^\\$])*)\$?$/.exec(src.split('(?:\\/([^/]+?))').join('\\/\u0000'));
  let p = m ? m[1] : '';
  let i = 0;
  p = p.replace(/\u0000/g, () => ':' + ((layer.keys[i++] || {}).name || 'p'));
  return p.replace(/\\\//g, '/').replace(/\\(.)/g, '$1');
}
function walk(stack, prefix, out) {
  for (const l of stack) {
    if (l.route) {
      for (const method of Object.keys(l.route.methods)) {
        if (method === '_all') continue;
        out.push({ method: method.toUpperCase(), path: (prefix + l.route.path).replace(/\/+/g, '/').replace(/(.)\/$/, '$1'), guards: l.route.stack.map((s) => s.name) });
      }
    } else if (l.name === 'router' && l.handle && l.handle.stack) walk(l.handle.stack, prefix + mountPath(l), out);
  }
}
/** Liste de { method, path, guards } pour une application Express. */
function listRoutes(app) { const out = []; walk(app._router.stack, '', out); return out; }
module.exports = { listRoutes };
