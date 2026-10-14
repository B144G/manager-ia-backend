'use strict';
// Base de connaissances des deux IA. Déposez simplement des fichiers .md dans :
//   knowledge/site/       -> assistant du site (visiteurs)
//   knowledge/workspace/  -> IA de l'espace de travail (gestion de l'activité des utilisateurs)
// Dans knowledge/workspace/ : « general*.md » est lu pour tous les modules ; « <module>*.md » (support, projects, budget,
// structure, processes, team) seulement pour ce module. Les fichiers sont relus automatiquement quand ils changent.
const fs = require('fs');
const path = require('path');
const config = require('../config');

const MAX_TOTAL = 26000; // caractères ajoutés au prompt (garde le coût et la latence raisonnables)
const cache = new Map(); // fichier -> { mtime, text }

function readFile(file) {
  try {
    const mtime = fs.statSync(file).mtimeMs;
    const hit = cache.get(file);
    if (hit && hit.mtime === mtime) return hit.text;
    const text = fs.readFileSync(file, 'utf8').trim();
    cache.set(file, { mtime, text });
    return text;
  } catch {
    return '';
  }
}

/** Texte de connaissances pour une IA ('site' ou 'workspace'), éventuellement filtré par module. */
function load(area, module) {
  const dir = path.join(config.knowledgeDir, area);
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.md') && !/^readme/i.test(f) && !f.startsWith('_')).sort();
  } catch {
    return '';
  }
  if (area === 'workspace') {
    // Ordre de priorité (si la limite est atteinte, le plus important est déjà dedans) : général, puis le module, puis la vision.
    // La vision complète (mission-*) n'est lue que pour l'assistant général, pour limiter le coût des autres modules.
    const rank = (f) => (f.startsWith('general') ? 0 : module && f.startsWith(module) ? 1 : f.startsWith('mission') && module === 'general' ? 2 : 9);
    files = files.filter((f) => rank(f) < 9).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  }
  let out = '';
  for (const f of files) {
    const t = readFile(path.join(dir, f));
    if (!t) continue;
    if (out.length + t.length > MAX_TOTAL) break;
    out += `\n\n### ${f.replace(/\.md$/, '')}\n${t}`;
  }
  return out.trim();
}

module.exports = { load };
